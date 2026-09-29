import { buildEvidence, extractText, hasEventKind, makeResult, runText } from '../caseHelpers.js';
import { findFieldsByKeyPattern } from '../rawInspect.js';
import { ownLiterals } from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

const USAGE_TEXT = '请用一句话解释什么是 WebSocket 协议。';

/** #18 Lượng Token sử dụng hoặc ước tính: Frame gốc có các trường liên quan đến lượng sử dụng không. */
export async function caseTokenUsageEstimate(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, USAGE_TEXT);
  const hits = findFieldsByKeyPattern(outcome.rawMessages, /token|usage/i);

  return makeResult({
    id: 'token_usage_estimate',
    index: 18,
    name: 'Token 使用量或可估算使用量',
    status: outcome.errorCategory !== null ? 'unknown' : hits.length > 0 ? 'native' : 'unsupported',
    summary:
      hits.length > 0
        ? `原始帧里发现 ${hits.length} 个疑似用量相关字段（键名匹配 token/usage）。`
        : '原始帧里没有发现任何键名匹配 token/usage 的字段，上游可能不下发用量信息。',
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(USAGE_TEXT), { usage_like_fields: hits }),
  });
}

const CITATION_PROMPT = '最近有哪些值得关注的科技行业动态？如果参考了外部来源，请说明来源。';

/** #19 Thông tin trích dẫn và nguồn: Các trường citation thường gặp của Copilot có xuất hiện không. */
export async function caseCitationsSources(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, CITATION_PROMPT);
  const hasCitation = hasEventKind(outcome, 'citation');

  return makeResult({
    id: 'citations_sources',
    index: 19,
    name: '引用与来源信息',
    status: outcome.errorCategory !== null ? 'unknown' : hasCitation ? 'native' : 'unknown',
    summary: hasCitation
      ? '本轮回复带有引用/来源信息（sourceAttributions 命中）。'
      : '本轮回复未带引用信息；不能排除是模型判断本题不需要引用，建议多跑几次或换用更需要联网信息的问题。',
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(CITATION_PROMPT), { has_citation: hasCitation }),
  });
}

const MODEL_QUESTION = '请如实说明你现在实际运行的模型名称或版本标识，不要编造。';
const MODEL_NAME_HINTS = ['gpt', 'o1', 'o3', 'copilot', 'bing', 'sydney', 'phi'];

/** #20 Lựa chọn tên mô hình: Trường mô hình do client chỉ định trong passthrough có được upstream chấp nhận / không báo lỗi không. */
export async function caseModelSelection(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const requestedModel = 'gpt-4.1-probe-test';
  const outcome = await runText(ctx, '请回复「收到」二字确认连通性即可。', {
    passthrough: { model: requestedModel },
  });

  const accepted = outcome.errorCategory === null && extractText(outcome).trim() !== '';

  return makeResult({
    id: 'model_selection',
    index: 20,
    name: '模型名称选择（能否指定 / 是否被忽略）',
    status: accepted ? 'partial' : outcome.errorCategory === 'fatal_client' ? 'unsupported' : 'unknown',
    summary: accepted
      ? `携带 passthrough.model="${requestedModel}" 未导致请求被拒绝，但无法在适配器层确认上游是否真的按该模型作答（见 #21）。`
      : `携带模型字段的请求未成功：${outcome.errorMessage ?? '无内容'}。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals('请回复「收到」二字确认连通性即可。'), {
      requested_model: requestedModel,
      request_accepted: accepted,
    }),
  });
}

/** #21 Thông tin mô hình thực tế do upstream trả về: Cấu trúc frame gốc có mang trường mô hình không, văn bản phản hồi có đề cập tên mô hình nhận diện được không. */
export async function caseReportedUpstreamModel(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, MODEL_QUESTION);

  const text = extractText(outcome).toLowerCase();
  const mentionsModelName = MODEL_NAME_HINTS.some((hint) => text.includes(hint));
  const modelFieldHits = findFieldsByKeyPattern(outcome.rawMessages, /^model$|modelname|model_name/i);

  const status: CapabilityResult['status'] =
    outcome.errorCategory !== null
      ? 'unknown'
      : modelFieldHits.length > 0
        ? 'native'
        : mentionsModelName
          ? 'partial'
          : 'unknown';

  return makeResult({
    id: 'reported_upstream_model',
    index: 21,
    name: '上游返回的实际模型信息',
    status,
    summary:
      modelFieldHits.length > 0
        ? `原始帧里发现 ${modelFieldHits.length} 个疑似模型字段。回复文本${mentionsModelName ? '也' : '未'}提到可识别的模型名称。`
        : mentionsModelName
          ? '原始帧里没有结构化模型字段，但回复文本里提到了可识别的模型名称（弱证据，模型的自我描述不一定准确）。'
          : '既没有结构化模型字段，回复文本也没有提到可识别的模型名称。',
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(MODEL_QUESTION), {
      model_field_hits: modelFieldHits,
      mentions_model_name_in_text: mentionsModelName,
    }),
  });
}
