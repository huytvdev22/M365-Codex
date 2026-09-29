import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Danh mục mô hình.
 *
 * Giá trị model được truyền nguyên bản lên upstream, container không viết lại, không tạo bí danh (rào chắn §1.4). Danh mục này chỉ dùng để
 * hiển thị cho `/v1/models` và cho phía Codex lựa chọn, không tham gia vào bất kỳ quyết định định tuyến nào.
 * Cho phép ghi đè qua biến môi trường MODELS_FILE, thuận tiện cho việc vận hành cập nhật mà không cần sửa image.
 */

export interface ModelEntry {
  id: string;
  object: 'model';
  created?: number;
  owned_by: string;
}

export interface ModelList {
  object: 'list';
  data: ModelEntry[];
}

const FALLBACK: ModelList = {
  object: 'list',
  data: [{ id: 'gpt-5-codex', object: 'model', owned_by: 'm365-codex' }],
};

function defaultModelsPath(): string {
  // Sau khi build nằm tại apps/server/dist/responses/models.js, file config ở gốc repo tại ../../../../config
  return fileURLToPath(new URL('../../../../config/models.json', import.meta.url));
}

/**
 * Đọc danh mục mô hình.
 *
 * Khi không đọc được sẽ hạ cấp về FALLBACK chỉ chứa một mô hình, nhưng **bắt buộc phải cho bên gọi biết** —
 * Việc âm thầm hạ cấp sẽ khiến `/v1/models` liệt kê thiếu mô hình mà không ai hay biết (đã từng gặp trong thực tế: image copy thiếu thư mục config/,
 * production chỉ trả về 1 model trong khi file cấu hình có 3 cái, mất nhiều thời gian điều tra mới phát hiện).
 * Truyền `onFallback` để ghi nhận nguyên nhân vào log.
 */
export function loadModels(
  path = process.env.MODELS_FILE ?? defaultModelsPath(),
  onFallback?: (reason: string) => void,
): ModelList {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (!Array.isArray(parsed.data)) {
      onFallback?.(`模型目录 ${path} 里没有 data 数组，已退回内置目录`);
      return FALLBACK;
    }
    const data = parsed.data
      .filter((entry): entry is ModelEntry => typeof entry === 'object' && entry !== null && 'id' in entry)
      .map((entry) => ({
        id: String(entry.id),
        object: 'model' as const,
        owned_by: entry.owned_by ?? 'm365-codex',
        ...(entry.created === undefined ? {} : { created: entry.created }),
      }));
    return { object: 'list', data };
  } catch (error) {
    onFallback?.(`读取模型目录 ${path} 失败（${(error as Error).message}），已退回内置目录`);
    return FALLBACK;
  }
}
