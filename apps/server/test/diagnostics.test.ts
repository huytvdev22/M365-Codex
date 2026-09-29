import { describe, expect, it } from 'vitest';
import { buildDiagnostics, deriveSystemStatus, type DiagnosticsInput } from '../src/observability/diagnostics.js';

/**
 * Gói chẩn đoán (§17). Tiêu chuẩn để xác định một mục có nên vào gói hay không: dán nó vào issue công khai có phải hối hận không.
 */

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: '1.0.0',
    schemaVersion: 7,
    expectedSchemaVersion: 7,
    startedAt: 1_000,
    now: 61_000,
    accountsByStatus: {
      probing: 0,
      online: 2,
      busy: 1,
      cooldown: 1,
      reauth_required: 0,
      disabled: 0,
      unsupported: 0,
      error: 0,
    },
    recentErrorsByType: { upstream_error: 3, rate_limit_error: 1 },
    inFlightRequests: 2,
    configSummary: { port: 8080, logPrivacyMode: 'strict', masterKeyConfigured: true },
    storage: { dbBytes: 1024, filesBytes: 2048, fileCount: 3 },
    maintenanceJobs: [{ name: 'expired-files', lastRunAt: 60_000, lastError: null }],
    readiness: [{ name: 'master_key', ok: true }],
    ...overrides,
  };
}

describe('系统状态判定', () => {
  it('一切正常时是 normal', () => {
    expect(deriveSystemStatus({ schemaOk: true, readinessOk: true, usableAccounts: 2, totalAccounts: 3 })).toBe(
      'normal',
    );
  });

  it('迁移没跑到位优先级最高', () => {
    expect(
      deriveSystemStatus({ schemaOk: false, readinessOk: false, usableAccounts: 0, totalAccounts: 0 }),
    ).toBe('migration_failed');
  });

  it('有账号但一个都不可调度 → upstream_unavailable', () => {
    expect(deriveSystemStatus({ schemaOk: true, readinessOk: true, usableAccounts: 0, totalAccounts: 3 })).toBe(
      'upstream_unavailable',
    );
  });

  it('一个账号都没添加过算 degraded，不是上游挂了', () => {
    expect(deriveSystemStatus({ schemaOk: true, readinessOk: true, usableAccounts: 0, totalAccounts: 0 })).toBe(
      'degraded',
    );
  });
});

describe('诊断包内容', () => {
  it('汇总版本、运行时长、账号分布与可用数', () => {
    const report = buildDiagnostics(input());
    expect(report.app_version).toBe('1.0.0');
    expect(report.uptime_ms).toBe(60_000);
    // online + busy mới tính là khả dụng; cooldown không tính
    expect(report.accounts_usable).toBe(3);
    expect(report.system_status).toBe('normal');
    expect(report.schema.ok).toBe(true);
  });

  it('结构版本不一致时给出提示并判为 migration_failed', () => {
    const report = buildDiagnostics(input({ schemaVersion: 5 }));
    expect(report.system_status).toBe('migration_failed');
    expect(report.notes.join()).toContain('v5');
  });

  it('维护任务失败会写进提示', () => {
    const report = buildDiagnostics(
      input({ maintenanceJobs: [{ name: 'expired-files', lastRunAt: 1, lastError: '磁盘只读' }] }),
    );
    expect(report.notes.join()).toContain('expired-files');
  });

  it('没有账号时提示先做 PKCE 授权', () => {
    const report = buildDiagnostics(
      input({
        accountsByStatus: {
          probing: 0, online: 0, busy: 0, cooldown: 0,
          reauth_required: 0, disabled: 0, unsupported: 0, error: 0,
        },
      }),
    );
    expect(report.notes.join()).toContain('PKCE');
  });
});

describe('隐私', () => {
  it('诊断包里没有邮箱、提示词、Token 之类的东西', () => {
    // Cho dù phía gọi vô tình nhét giá trị nhạy cảm vào configSummary, summarizeConfig cũng phải chịu trách nhiệm khử nhạy cảm;
    // ở đây assert là bản thân gói chẩn đoán sẽ không chủ động lấy bất kỳ trường nội dung người dùng nào
    const report = buildDiagnostics(input());
    const dump = JSON.stringify(report);
    expect(dump).not.toContain('@');
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{6,}/);
    expect(dump).not.toContain('sk-');
    // Chỉ nên chứa các bộ đếm có cấu trúc và tóm tắt cấu hình
    expect(Object.keys(report)).toEqual(
      expect.arrayContaining(['accounts', 'recent_errors', 'storage', 'readiness', 'config']),
    );
  });
});
