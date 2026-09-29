import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { SHUTDOWN_ABORT_REASON, InFlightRegistry } from '../src/responses/inFlight.js';
import { gracefulShutdown } from '../src/server.js';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * Đóng an toàn (§19): Khi đóng phải chủ động hủy kết nối upstream của các yêu cầu đang xử lý, và đưa các Response
 * còn đang in_progress vào DB với trạng thái incomplete — cách xử lý nhất quán với phục hồi khi khởi động lại của `recovery.ts`,
 * không viết hai bộ ngữ nghĩa; tuyệt đối không tự động phát lại bất kỳ thao tác nào có tác dụng phụ.
 */

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;

afterEach(async () => {
  await harness?.close().catch(() => undefined);
  harness = undefined;
  await server?.close();
  server = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时');
    await delay(5);
  }
}

describe('InFlightRegistry.cancelAll', () => {
  it('中止全部登记中的 AbortController，标记 reason 为关闭专用哨兵值，并清空登记表', () => {
    const registry = new InFlightRegistry();
    const c1 = new AbortController();
    const c2 = new AbortController();
    registry.register('resp_a', c1);
    registry.register('resp_b', c2);

    const ids = registry.cancelAll();

    expect(ids.sort()).toEqual(['resp_a', 'resp_b']);
    expect(c1.signal.aborted).toBe(true);
    expect(c1.signal.reason).toBe(SHUTDOWN_ABORT_REASON);
    expect(c2.signal.aborted).toBe(true);
    expect(c2.signal.reason).toBe(SHUTDOWN_ABORT_REASON);
    expect(registry.size).toBe(0);
  });

  it('没有在途请求时是安全的空操作', () => {
    const registry = new InFlightRegistry();
    expect(registry.cancelAll()).toEqual([]);
  });
});

describe('gracefulShutdown', () => {
  it('中止在途请求的上游连接，把仍处于 in_progress 的记录落库为 incomplete', async () => {
    server = await startMockSydneyServer({ kind: 'idle' });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't',
      oid: 'o',
      email: 'u@office.example.invalid',
      displayName: 'u',
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });

    // Nắm giữ tham chiếu sẽ dùng sau: gracefulShutdown sẽ đóng db, nhưng bài test này
    // muốn kiểm tra trạng thái database sau khi quy trình đóng chạy xong, vì vậy đưa cho nó một proxy "không thực sự đóng" —
    // db.close() thật sẽ tự gọi ở cuối bài test này
    const { app, db, context } = harness;
    const dbNoClose = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'close') return () => undefined;
        return Reflect.get(target, prop, receiver);
      },
    });

    const pending = app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key.key}` },
      payload: { model: 'gpt-5-codex', input: '在吗' },
    });

    // Upstream là 'idle' (sau khi bắt tay không gửi gì), yêu cầu sẽ kẹt mãi ở in_progress,
    // cho đến khi được đăng ký vào inFlight — ở đây đợi nó thực sự vào trạng thái này mới kích hoạt đóng
    await waitFor(() => context.inFlight.size > 0);
    expect(context.inFlight.size).toBe(1);

    const logger = pino({ level: 'silent' });
    await gracefulShutdown({ context, app, db: dbNoClose, logger }, 'SIGTERM');
    harness = undefined; // app đã được gracefulShutdown đóng, afterEach không cần đóng lại lần nữa

    expect(context.inFlight.size).toBe(0);

    // Yêu cầu đang treo phải kết thúc cùng với abort (không ném lỗi và không treo vĩnh viễn)
    await pending.catch(() => undefined);

    const rows = db.prepare('SELECT id, status, body FROM responses').all() as {
      id: string;
      status: string;
      body: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('incomplete');
    const body = JSON.parse(rows[0]?.body ?? '{}') as { incomplete_details: { reason: string } | null };
    expect(body.incomplete_details).toEqual({ reason: 'server_shutting_down' });

    db.close();
  });

  it('没有在途请求时也能正常走完关闭流程', async () => {
    harness = await createTestHarness();
    const { app, db, context } = harness;
    const logger = pino({ level: 'silent' });

    await gracefulShutdown({ context, app, db, logger }, 'SIGINT');
    harness = undefined;

    expect(context.inFlight.size).toBe(0);
  });

  it('停止定时任务调度，关闭后不再产生新的调度动作', async () => {
    harness = await createTestHarness();
    const { app, db, context } = harness;
    context.scheduler.start({ initialDelayMs: 60_000 });

    const logger = pino({ level: 'silent' });
    await gracefulShutdown({ context, app, db, logger }, 'SIGTERM');
    harness = undefined;

    // Sau stop() việc đăng ký lại phải được phép thất bại (chứng tỏ đã thực sự dừng, trạng thái được đặt lại) —
    // ở đây đổi một cách assert khác: trực tiếp xác nhận register không còn ném lỗi "dispatcher đã khởi động"
    expect(() => context.scheduler.register({ name: 'x', intervalMs: 1000, run: () => 0 })).not.toThrow();
  });
});
