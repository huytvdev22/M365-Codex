import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { MaintenanceScheduler } from '../src/maintenance/scheduler.js';

/** Điều phối bảo trì định kỳ: Một tác vụ thất bại không ảnh hưởng tác vụ khác, trạng thái có thể tra cứu. */

function makeScheduler(): MaintenanceScheduler {
  return new MaintenanceScheduler(pino({ level: 'silent' }));
}

describe('执行与状态', () => {
  it('runAll 跑完所有任务并记录处理条数', async () => {
    const scheduler = makeScheduler();
    scheduler.register({ name: 'a', intervalMs: 1000, run: () => 3 });
    scheduler.register({ name: 'b', intervalMs: 1000, run: async () => Promise.resolve(0) });

    const statuses = await scheduler.runAll();
    expect(statuses.map((s) => s.name)).toEqual(['a', 'b']);
    expect(statuses[0]?.lastAffected).toBe(3);
    expect(statuses[1]?.lastAffected).toBe(0);
    expect(statuses.every((s) => s.lastError === null && s.runCount === 1)).toBe(true);
  });

  it('一个任务抛错不影响其它任务', async () => {
    const scheduler = makeScheduler();
    let ranAfter = false;
    scheduler.register({
      name: 'boom',
      intervalMs: 1000,
      run: () => {
        throw new Error('故意失败');
      },
    });
    scheduler.register({
      name: 'after',
      intervalMs: 1000,
      run: () => {
        ranAfter = true;
        return 1;
      },
    });

    const statuses = await scheduler.runAll();
    expect(statuses[0]?.lastError).toBe('故意失败');
    expect(statuses[0]?.lastAffected).toBeNull();
    expect(ranAfter).toBe(true);
    expect(statuses[1]?.lastError).toBeNull();
  });

  it('runNow 只跑指定任务', async () => {
    const scheduler = makeScheduler();
    let bRan = 0;
    scheduler.register({ name: 'a', intervalMs: 1000, run: () => 1 });
    scheduler.register({ name: 'b', intervalMs: 1000, run: () => (bRan += 1) });

    const status = await scheduler.runNow('a');
    expect(status.name).toBe('a');
    expect(bRan).toBe(0);
  });

  it('runNow 遇到不存在的任务名报错', async () => {
    const scheduler = makeScheduler();
    await expect(scheduler.runNow('nope')).rejects.toThrow(/没有名为/);
  });

  it('启动后不允许再注册任务', () => {
    const scheduler = makeScheduler();
    scheduler.start({ initialDelayMs: 60_000 });
    expect(() => scheduler.register({ name: 'late', intervalMs: 1000, run: () => 0 })).toThrow(/启动后/);
    scheduler.stop();
  });
});
