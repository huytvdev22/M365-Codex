import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverOnStartup } from '../src/maintenance/recovery.js';
import { ResponseRepository } from '../src/repo/responses.js';
import { ToolCallRepository } from '../src/repo/toolCalls.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';

/**
 * Phục hồi sau khởi động lại (§18): queued giữ nguyên trạng có thể tra cứu; in_progress không thể xác nhận tiến độ,
 * đều được đánh dấu là incomplete; các lệnh gọi công cụ đã gửi được giữ nguyên, tuyệt đối không tự động phát lại.
 */

let db: Database;
let responses: ResponseRepository;
let toolCalls: ToolCallRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  responses = new ResponseRepository(db);
  toolCalls = new ToolCallRepository(db);
});

afterEach(() => {
  db.close();
});

function makeLogger() {
  return pino({ level: 'silent' });
}

describe('queued', () => {
  it('保持原状，仍可查询', () => {
    responses.create({
      id: 'resp_queued_1',
      apiKeyId: null,
      status: 'queued',
      requestedModel: 'gpt-5-codex',
      requestedReasoningEffort: null,
      upstreamModelParameter: 'gpt-5-codex',
      previousResponseId: null,
      idempotencyKey: null,
    });

    const result = recoverOnStartup({ responses, logger: makeLogger() });
    expect(result.queuedKept).toBe(1);
    expect(result.inProgressMarkedIncomplete).toBe(0);
    expect(responses.findById('resp_queued_1')?.status).toBe('queued');
  });
});

describe('in_progress', () => {
  it('标记为 incomplete，并带 incomplete_details.reason', () => {
    responses.create({
      id: 'resp_stuck_1',
      apiKeyId: null,
      status: 'queued',
      requestedModel: 'gpt-5-codex',
      requestedReasoningEffort: 'medium',
      upstreamModelParameter: 'gpt-5-codex',
      previousResponseId: null,
      idempotencyKey: null,
    });
    responses.updateStatus('resp_stuck_1', 'in_progress');

    const result = recoverOnStartup({ responses, logger: makeLogger() });
    expect(result.inProgressMarkedIncomplete).toBe(1);

    const row = responses.findById('resp_stuck_1');
    expect(row?.status).toBe('incomplete');
    const body = responses.readBody('resp_stuck_1');
    expect(body?.status).toBe('incomplete');
    expect(body?.incomplete_details).toEqual({ reason: 'server_restarted' });
    expect(body?.reasoning).toEqual({ effort: 'medium' });
  });

  it('已发出的工具调用原样保留，不被恢复流程改动或重放', () => {
    responses.create({
      id: 'resp_stuck_2',
      apiKeyId: null,
      status: 'in_progress',
      requestedModel: 'gpt-5-codex',
      requestedReasoningEffort: null,
      upstreamModelParameter: 'gpt-5-codex',
      previousResponseId: null,
      idempotencyKey: null,
    });
    toolCalls.recordEmitted({
      responseId: 'resp_stuck_2',
      callId: 'call_1',
      name: 'shell',
      arguments: '{"cmd":"ls"}',
      sideEffect: true,
    });

    recoverOnStartup({ responses, logger: makeLogger() });

    const call = toolCalls.findByCallId('resp_stuck_2', 'call_1');
    expect(call?.status).toBe('emitted');
    expect(call?.name).toBe('shell');
  });

  it('多条 in_progress 记录全部处理，互不影响', () => {
    for (const id of ['resp_a', 'resp_b', 'resp_c']) {
      responses.create({
        id,
        apiKeyId: null,
        status: 'in_progress',
        requestedModel: 'gpt-5-codex',
        requestedReasoningEffort: null,
        upstreamModelParameter: 'gpt-5-codex',
        previousResponseId: null,
        idempotencyKey: null,
      });
    }

    const result = recoverOnStartup({ responses, logger: makeLogger() });
    expect(result.inProgressMarkedIncomplete).toBe(3);
    for (const id of ['resp_a', 'resp_b', 'resp_c']) {
      expect(responses.findById(id)?.status).toBe('incomplete');
    }
  });
});

describe('已完成的记录', () => {
  it('completed / failed 不受恢复流程影响', () => {
    responses.create({
      id: 'resp_done',
      apiKeyId: null,
      status: 'in_progress',
      requestedModel: 'gpt-5-codex',
      requestedReasoningEffort: null,
      upstreamModelParameter: 'gpt-5-codex',
      previousResponseId: null,
      idempotencyKey: null,
    });
    responses.complete('resp_done', 'completed', {
      id: 'resp_done',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5-codex',
      output: [],
      usage: null,
      metadata: null,
      previous_response_id: null,
      reasoning: null,
      max_output_tokens: null,
      temperature: null,
      error: null,
      incomplete_details: null,
    });

    const result = recoverOnStartup({ responses, logger: makeLogger() });
    expect(result.inProgressMarkedIncomplete).toBe(0);
    expect(responses.findById('resp_done')?.status).toBe('completed');
  });
});
