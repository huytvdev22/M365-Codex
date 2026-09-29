import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@m365-codex/shared';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { PrivacyModeHolder } from '../src/observability/privacyMode.js';
import { AuditLogRepository } from '../src/repo/auditLogs.js';
import { SettingsRepository } from '../src/repo/settings.js';
import { buildEnvOverridesFromSettings, SettingsService } from '../src/settings/service.js';
import { testEnv } from './helpers/testApp.js';

/**
 * Đọc ghi cài đặt (hợp đồng §2.3): Mục được đặt rõ ràng qua biến môi trường có source=env, editable=false;
 * các mục còn lại lưu vào bảng settings, mục có requires_restart=true vào pending_restart;
 * `logging.log_level` và `logging.log_privacy_mode` là hai mục có hiệu lực nóng thực sự — mục sau là
 * để debug tự động hết hạn (§15.3) có thể siết chặt ngay về strict mà không cần đợi
 * đến lần khởi động lại tiếp theo.
 */

let db: Database;
let config: AppConfig;
let repo: SettingsRepository;
let service: SettingsService;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  config = loadConfig(testEnv());
  repo = new SettingsRepository(db);
  service = new SettingsService({ repo, config, logger: pino({ level: 'silent' }) });
});

afterEach(() => {
  db.close();
});

describe('默认值', () => {
  it('未被 env 或 db 覆盖的项显示 default 来源，值取自内置默认', () => {
    const view = service.getGroup('tools');
    expect(view.mode).toEqual({ value: 'auto', source: 'default', editable: true, requires_restart: true });
  });
});

describe('env 显式设置', () => {
  it('LOG_LEVEL 被 testEnv 显式设置，因此 source=env 且不可编辑', () => {
    const view = service.getGroup('logging');
    expect(view.log_level?.source).toBe('env');
    expect(view.log_level?.editable).toBe(false);
  });

  it('修改 env 锁定的项被拒绝（403）', () => {
    expect(() => service.patchGroup('logging', { log_level: 'debug' })).toThrow(ApiError);
  });
});

describe('PATCH 落库与读取', () => {
  it('写入后再读取反映 db 来源', () => {
    service.patchGroup('tools', { max_rounds: 5 });
    const view = service.getGroup('tools');
    expect(view.max_rounds).toEqual({ value: 5, source: 'db', editable: true, requires_restart: true });
  });

  it('类型不合法时拒绝，不写库', () => {
    expect(() => service.patchGroup('tools', { max_rounds: 'five' })).toThrow(ApiError);
    expect(service.getGroup('tools').max_rounds?.source).toBe('default');
  });

  it('max_arg_repairs 不能突破协议上限 2', () => {
    expect(() => service.patchGroup('tools', { max_arg_repairs: 5 })).toThrow(ApiError);
  });

  it('未知字段拒绝', () => {
    expect(() => service.patchGroup('tools', { not_a_field: 1 })).toThrow(ApiError);
  });

  it('一次 patch 里一项不合法则整体不生效', () => {
    expect(() =>
      service.patchGroup('tools', { max_rounds: 5, max_calls_per_round: 'nope' }),
    ).toThrow(ApiError);
    expect(service.getGroup('tools').max_rounds?.source).toBe('default');
  });
});

describe('log_level 热生效', () => {
  it('patch 后立刻改变 logger.level，无需重启', () => {
    const logger = pino({ level: 'info' });
    const config2 = loadConfig(testEnv({ LOG_LEVEL: undefined }));
    const svc = new SettingsService({ repo, config: config2, logger });
    svc.patchGroup('logging', { log_level: 'debug' });
    expect(logger.level).toBe('debug');
    expect(svc.getGroup('logging').log_level).toEqual({
      value: 'debug',
      source: 'db',
      editable: true,
      requires_restart: false,
    });
  });
});

describe('pendingRestartEnvVars', () => {
  it('requires_restart 项写库后出现在待重启列表；env 锁定的项不出现', () => {
    service.patchGroup('tools', { max_rounds: 9 });
    const pending = service.pendingRestartEnvVars();
    expect(pending).toContain('TOOLS_MAX_ROUNDS');
    expect(pending).not.toContain('LOG_LEVEL');
  });

  it('写入的值与当前生效值相同时不算 pending', () => {
    service.patchGroup('tools', { max_rounds: config.tools.maxRounds });
    expect(service.pendingRestartEnvVars()).not.toContain('TOOLS_MAX_ROUNDS');
  });
});

describe('buildEnvOverridesFromSettings', () => {
  it('把 db 里的改动合成 env 覆盖层，供下次启动使用', () => {
    service.patchGroup('tools', { max_rounds: 9, allow_parallel: false });
    const overrides = buildEnvOverridesFromSettings(repo, config.envKeysPresent);
    expect(overrides.TOOLS_MAX_ROUNDS).toBe('9');
    expect(overrides.TOOLS_ALLOW_PARALLEL).toBe('false');
  });

  it('env 已显式设置的项不会被覆盖', () => {
    // testEnv mặc định đã đặt LOG_LEVEL, cho dù trong DB có logging.log_level cũng không được xuất hiện trong overrides
    const overrides = buildEnvOverridesFromSettings(repo, config.envKeysPresent);
    expect(overrides.LOG_LEVEL).toBeUndefined();
  });
});

describe('log_privacy_mode 热生效（§15.3）', () => {
  it('requires_restart 为 false，且不出现在 pending_restart', () => {
    const view = service.getGroup('logging');
    expect(view.log_privacy_mode?.requires_restart).toBe(false);

    service.patchGroup('logging', { log_privacy_mode: 'metadata' });
    expect(service.pendingRestartEnvVars()).not.toContain('LOG_PRIVACY_MODE');
  });

  it('patch 后立刻影响 privacyMode.current，无需重启', () => {
    const privacyMode = new PrivacyModeHolder('strict');
    const svc = new SettingsService({ repo, config, logger: pino({ level: 'silent' }), privacyMode });
    svc.patchGroup('logging', { log_privacy_mode: 'metadata' });
    expect(privacyMode.current).toBe('metadata');
  });

  it('拒绝非法取值', () => {
    expect(() => service.patchGroup('logging', { log_privacy_mode: 'verbose' })).toThrow(ApiError);
  });
});

describe('debug 自动过期（§15.3）', () => {
  function makeService(overrides: { privacyMode?: PrivacyModeHolder; auditLogs?: AuditLogRepository } = {}) {
    return new SettingsService({ repo, config, logger: pino({ level: 'silent' }), ...overrides });
  }

  it('切到 debug 时按配置的 TTL 计算 debug_expires_at', () => {
    const now = 1_000_000;
    const svc = makeService();
    svc.patchGroup('logging', { log_privacy_mode: 'debug' });
    const view = svc.getGroup('logging');
    expect(view.debug_expires_at?.editable).toBe(false);
    expect(view.debug_expires_at?.requires_restart).toBe(false);
    expect(typeof view.debug_expires_at?.value).toBe('number');

    const expiresAt = view.debug_expires_at?.value as number;
    expect(expiresAt).toBeGreaterThan(now); // Date.now() tại thời điểm chạy test, chỉ yêu cầu lớn hơn một mốc sớm
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(config.logPrivacyDebugTtlMs + 5_000);
  });

  it('切回 strict/metadata 时清掉 debug_expires_at，不留悬空状态', () => {
    const svc = makeService();
    svc.patchGroup('logging', { log_privacy_mode: 'debug' });
    expect(svc.getGroup('logging').debug_expires_at?.value).not.toBeNull();

    svc.patchGroup('logging', { log_privacy_mode: 'strict' });
    expect(svc.getGroup('logging').debug_expires_at?.value).toBeNull();
  });

  it('未到期时 enforceDebugExpiry 不做任何事', () => {
    const svc = makeService();
    svc.patchGroup('logging', { log_privacy_mode: 'debug' });
    const affected = svc.enforceDebugExpiry(Date.now());
    expect(affected).toBe(0);
    expect(svc.getGroup('logging').log_privacy_mode?.value).toBe('debug');
  });

  it('到期后自动恢复 strict、清掉过期时间、写审计日志', () => {
    const auditLogs = new AuditLogRepository(db);
    const privacyMode = new PrivacyModeHolder('strict');
    const svc = makeService({ privacyMode, auditLogs });

    svc.patchGroup('logging', { log_privacy_mode: 'debug' });
    privacyMode.set('debug'); // Mô phỏng chuyển đổi nóng do patchGroup kích hoạt đã có hiệu lực
    const expiresAt = svc.getGroup('logging').debug_expires_at?.value as number;

    const affected = svc.enforceDebugExpiry(expiresAt + 1);
    expect(affected).toBe(1);

    expect(svc.getGroup('logging').log_privacy_mode?.value).toBe('strict');
    expect(svc.getGroup('logging').debug_expires_at?.value).toBeNull();
    expect(privacyMode.current).toBe('strict');

    const logs = auditLogs.recent(10);
    const entry = logs.find((row) => row.action === 'settings.log_privacy_mode.debug_expired');
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe('system');
  });

  it('没有 privacyMode/auditLogs 依赖时也能安全跑完（不强制要求这两个依赖）', () => {
    const svc = makeService();
    svc.patchGroup('logging', { log_privacy_mode: 'debug' });
    expect(() => svc.enforceDebugExpiry(Date.now() + config.logPrivacyDebugTtlMs + 1)).not.toThrow();
    expect(svc.getGroup('logging').log_privacy_mode?.value).toBe('strict');
  });
});
