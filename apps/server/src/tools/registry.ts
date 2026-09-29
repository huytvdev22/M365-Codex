import { ApiError } from '@m365-codex/shared';
import Ajv2020Cjs from 'ajv/dist/2020.js';
import type { ToolDeclaration } from '../adapter/protocol.js';

// ajv là CJS, dưới NodeNext import mặc định liên kết namespace, class thực sự nằm trên .default
const Ajv2020 = Ajv2020Cjs.default;

/**
 * Phân tích, xác thực khai báo công cụ (hàm) và xác thực tham số (tương ứng kế hoạch triển khai §7.2, §7.3).
 *
 * Chấp nhận 2 cách viết công cụ function của OpenAI Responses:
 *   { type: 'function', name, description, parameters }        (phẳng)
 *   { type: 'function', function: { name, description, parameters } } (lồng nhau)
 *
 * Tham số dùng JSON Schema để kiểm tra tham số gọi công cụ do mô hình sinh ra; khi không hợp lệ sẽ trả về lỗi dễ đọc,
 * phục vụ cho cơ chế "tối đa 2 lần sửa tham số".
 */

export interface ParsedTool {
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
  /**
   * Có khả năng gây tác dụng phụ hay không. Mặc định true (thận trọng: không bao giờ tự động phát lại bất kỳ lệnh gọi công cụ nào qua tài khoản khác).
   * Trong định nghĩa công cụ có thể dùng `x_side_effect: false` để đánh dấu rõ ràng là chỉ đọc.
   */
  sideEffect: boolean;
}

/**
 * Lý do kiểm tra tham số thất bại. Cách xử lý của 3 loại này khác nhau (§7.3):
 * - `undeclared`  —— Gọi công cụ chưa khai báo, sau khi sửa không thành công thì **tuyệt đối không gửi cho client**;
 * - `invalid_json` —— Tham số không phải JSON hợp lệ, sửa không thành công thì gửi đi client cũng không parse được, đánh giá thất bại;
 * - `schema`      —— JSON hợp lệ nhưng không thỏa mãn schema công cụ, sửa không thành công thì gửi nguyên dạng và ghi log cảnh báo.
 */
export type ValidationReason = 'undeclared' | 'invalid_json' | 'schema';

export interface ArgumentValidation {
  valid: boolean;
  reason?: ValidationReason;
  /** Tóm tắt lỗi con người có thể đọc được, dùng để yêu cầu mô hình sửa đổi */
  errors: string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Công cụ bị bỏ qua: Client đã khai báo nhưng gateway này không thể thực thi (công cụ OpenAI quản lý, v.v.). */
export interface SkippedTool {
  name: string;
  type: string;
  reason: string;
}

/**
 * Phân tích một định nghĩa công cụ, trả về **một hoặc nhiều** ParsedTool.
 *
 * Codex thực tế (v0.145) sẽ gửi 3 dạng, ở đây đều phải nhận diện (packet capture thực tế ngày 2026-07-26):
 *   { type:'function', name, description, strict, parameters }   —— function phẳng
 *   { type:'function', function:{…} }                            —— function lồng nhau
 *   { type:'namespace', name, description, tools:[function…] }   —— một nhóm công cụ con (như multi_agent_v1)
 * namespace được **làm phẳng** theo các công cụ con của nó để đăng ký: Mô hình vẫn gọi theo tên gốc của công cụ con, gateway chỉ tách nhóm ra.
 *
 * Các loại còn lại (web_search / file_search / code_interpreter / image_generation…) là
 * công cụ do OpenAI quản lý, dự án này không thể thực thi (xem §24.3). Loại này **bỏ qua thay vì báo lỗi**:
 * Trả về 422 trực tiếp sẽ khiến Codex với cấu hình mặc định hoàn toàn không dùng được, trong khi bỏ qua vừa không giả vờ hỗ trợ (công cụ không xuất hiện
 * trong danh mục gửi cho upstream, mô hình thực sự gọi cũng sẽ bị chặn bởi "công cụ chưa khai báo"), vừa có thể thông báo rõ cho caller qua skipped.
 */
export function parseTool(raw: unknown, index: number, skipped?: SkippedTool[]): ParsedTool[] {
  const obj = asObject(raw);
  if (obj === null) {
    throw ApiError.badRequest(`tools[${index}] 不是对象`, `tools.${index}`);
  }

  const type = obj.type;

  if (type === 'namespace') {
    const nested = Array.isArray(obj.tools) ? obj.tools : [];
    return nested.flatMap((child, childIndex) => parseTool(child, childIndex, skipped));
  }

  if (type !== undefined && type !== 'function') {
    const typeLabel = typeof type === 'string' ? type : typeof type;
    const name = typeof obj.name === 'string' ? obj.name : typeLabel;
    skipped?.push({
      name,
      type: typeLabel,
      reason: '托管工具需要 OpenAI 后端执行，本网关不具备该能力',
    });
    return [];
  }

  const fn = asObject(obj.function) ?? obj;
  const name = fn.name;
  if (typeof name !== 'string' || name === '') {
    throw ApiError.badRequest(`tools[${index}] 缺少 function name`, `tools.${index}.name`);
  }

  const description = typeof fn.description === 'string' ? fn.description : null;
  const parameters = asObject(fn.parameters);
  const sideEffectHint = fn.x_side_effect ?? obj.x_side_effect;
  const sideEffect = sideEffectHint === false ? false : true;

  return [{ name, description, parameters, sideEffect }];
}

/** Registry công cụ: index theo tên, dùng để kiểm tra tham số và xác định tác dụng phụ. */
export class ToolRegistry {
  readonly #tools = new Map<string, ParsedTool>();
  readonly #skipped: SkippedTool[];
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false });

  constructor(tools: ParsedTool[], skipped: SkippedTool[] = []) {
    for (const tool of tools) {
      this.#tools.set(tool.name, tool);
    }
    this.#skipped = skipped;
  }

  static fromRequest(rawTools: unknown[] | undefined): ToolRegistry {
    if (rawTools === undefined) return new ToolRegistry([]);
    const skipped: SkippedTool[] = [];
    const parsed = rawTools.flatMap((raw, index) => parseTool(raw, index, skipped));
    // Tên trùng lặp báo lỗi trực tiếp để tránh nhập nhằng
    const seen = new Set<string>();
    for (const tool of parsed) {
      if (seen.has(tool.name)) {
        throw ApiError.badRequest(`工具名重复：${tool.name}`, 'tools');
      }
      seen.add(tool.name);
    }
    return new ToolRegistry(parsed, skipped);
  }

  /** Công cụ client khai báo nhưng gateway này không thể thực thi và đã bị bỏ qua. Phía gọi nên dựa vào đây để thông báo cho người dùng. */
  get skipped(): readonly SkippedTool[] {
    return this.#skipped;
  }

  get size(): number {
    return this.#tools.size;
  }

  list(): ParsedTool[] {
    return [...this.#tools.values()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): ParsedTool | undefined {
    return this.#tools.get(name);
  }

  isSideEffect(name: string): boolean {
    // Công cụ chưa khai báo cũng xử lý như có tác dụng phụ (thận trọng)
    return this.#tools.get(name)?.sideEffect ?? true;
  }

  /** Chuyển đổi thành khai báo công cụ gửi cho upstream. */
  toDeclarations(): ToolDeclaration[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description ?? undefined,
      parameters: tool.parameters ?? undefined,
    }));
  }

  /**
   * Kiểm tra tham số gọi công cụ do mô hình sinh ra.
   * Công cụ chưa khai báo, JSON không hợp lệ hoặc không khớp schema đều trả về valid=false kèm tóm tắt lỗi.
   */
  validateArguments(name: string, argumentsJson: string): ArgumentValidation {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      // Tên công cụ khớp chính xác: khác biệt chữ hoa/thường, khoảng trắng đều tính là chưa khai báo
      return { valid: false, reason: 'undeclared', errors: [`调用了未声明的工具 ${name}`] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsJson === '' ? '{}' : argumentsJson);
    } catch {
      return { valid: false, reason: 'invalid_json', errors: ['工具参数不是合法 JSON'] };
    }

    // Công cụ không có schema tham số chỉ yêu cầu tham số là đối tượng JSON
    if (tool.parameters === null) {
      return typeof parsed === 'object' && parsed !== null
        ? { valid: true, errors: [] }
        : { valid: false, reason: 'schema', errors: ['工具参数应为 JSON 对象'] };
    }

    let validate;
    try {
      validate = this.#ajv.compile(tool.parameters);
    } catch (error) {
      // Bản thân schema không thể biên dịch: không chặn lệnh gọi nhưng ghi nhận lại
      return {
        valid: false,
        reason: 'schema',
        errors: [`工具 ${name} 的参数 schema 非法：${(error as Error).message}`],
      };
    }

    if (validate(parsed)) {
      return { valid: true, errors: [] };
    }
    const errors = (validate.errors ?? []).map((err) => {
      const path = err.instancePath === '' ? '(根)' : err.instancePath;
      return `${path} ${err.message ?? '不合法'}`;
    });
    return {
      valid: false,
      reason: 'schema',
      errors: errors.length > 0 ? errors : ['参数不符合工具 schema'],
    };
  }
}
