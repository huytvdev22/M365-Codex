import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseMasterKey, summarizeConfig } from '../src/config/index.js';

const validKey = randomBytes(32).toString('base64');
const baseEnv = {
  M365_CODEX_MASTER_KEY: validKey,
  M365_CODEX_ADMIN_PASSWORD: 'a-sufficiently-long-password',
};

describe('parseMasterKey', () => {
  it('接受 32 字节的 Base64 密钥', () => {
    expect(parseMasterKey(validKey).byteLength).toBe(32);
  });

  it('拒绝长度不足的密钥', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => parseMasterKey(short)).toThrow(/16 字节/);
  });

  it('拒绝非 Base64 字符串', () => {
    expect(() => parseMasterKey('这不是 base64!!')).toThrow(/Base64/);
  });

  it('拒绝空字符串', () => {
    expect(() => parseMasterKey('   ')).toThrow(/为空/);
  });
});

describe('loadConfig', () => {
  it('缺少主密钥时拒绝启动', () => {
    expect(() => loadConfig({ M365_CODEX_ADMIN_PASSWORD: 'a-sufficiently-long-password' })).toThrow(
      ConfigError,
    );
  });

  it('主密钥长度错误时拒绝启动，且不回显密钥内容', () => {
    const badKey = randomBytes(8).toString('base64');
    try {
      loadConfig({ ...baseEnv, M365_CODEX_MASTER_KEY: badKey });
      throw new Error('本应抛出 ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(badKey);
      expect((error as ConfigError).message).toContain('M365_CODEX_MASTER_KEY');
    }
  });

  it('管理密码过短时拒绝启动', () => {
    expect(() => loadConfig({ ...baseEnv, M365_CODEX_ADMIN_PASSWORD: 'short' })).toThrow(/至少 12 位/);
  });

  it('缺少管理密码时拒绝启动', () => {
    expect(() => loadConfig({ M365_CODEX_MASTER_KEY: validKey })).toThrow(ConfigError);
  });

  it('拒绝通过环境变量注入 Microsoft Token', () => {
    expect(() =>
      loadConfig({ ...baseEnv, MICROSOFT_ACCESS_TOKEN: 'eyJhbGciOi...' }),
    ).toThrow(/禁止通过环境变量注入 Microsoft 凭据/);
  });

  it('应用默认值', () => {
    const config = loadConfig(baseEnv);
    expect(config.port).toBe(8080);
    expect(config.dataDir).toBe('/data');
    expect(config.logPrivacyMode).toBe('strict');
    expect(config.trustProxy).toBe(false);
    expect(config.masterKeyVersion).toBe(1);
    expect(config.upstreamWsBase).toBeNull();
  });

  it('解析可选覆盖项', () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: '9000',
      DATA_DIR: '/srv/data',
      TRUST_PROXY: 'true',
      LOG_PRIVACY_MODE: 'metadata',
      PUBLIC_API_BASE_URL: 'https://codex.example.com/v1',
      UPSTREAM_WS_BASE: 'wss://substrate.office.com',
      MASTER_KEY_VERSION: '3',
    });
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe('/srv/data');
    expect(config.trustProxy).toBe(true);
    expect(config.logPrivacyMode).toBe('metadata');
    expect(config.publicApiBaseUrl).toBe('https://codex.example.com/v1');
    expect(config.upstreamWsBase).toBe('wss://substrate.office.com');
    expect(config.masterKeyVersion).toBe(3);
  });

  it('拒绝非法端口', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '70000' })).toThrow(/1-65535/);
  });

  it('拒绝非 http(s) 的公开地址', () => {
    expect(() => loadConfig({ ...baseEnv, PUBLIC_API_BASE_URL: 'ftp://example.com' })).toThrow(
      /http\/https/,
    );
  });

  it('拒绝非 ws(s) 的上游地址', () => {
    expect(() => loadConfig({ ...baseEnv, UPSTREAM_WS_BASE: 'https://example.com' })).toThrow(/ws\/wss/);
  });

  it('工具循环限制有可用默认值', () => {
    const { tools } = loadConfig(baseEnv);
    expect(tools.mode).toBe('auto');
    expect(tools.maxArgRepairs).toBe(2);
    expect(tools.allowParallel).toBe(true);
    expect(tools.maxRounds).toBeGreaterThan(0);
    expect(tools.maxResultBytes).toBeGreaterThan(1024);
  });

  it('工具循环限制可用环境变量覆盖', () => {
    const { tools } = loadConfig({
      ...baseEnv,
      TOOLS_MODE: 'prompt',
      TOOLS_MAX_ROUNDS: '3',
      TOOLS_MAX_CALLS_PER_ROUND: '2',
      TOOLS_ALLOW_PARALLEL: 'false',
    });
    expect(tools.mode).toBe('prompt');
    expect(tools.maxRounds).toBe(3);
    expect(tools.maxCallsPerRound).toBe(2);
    expect(tools.allowParallel).toBe(false);
  });

  it('参数修复次数不得超过协议上限 2', () => {
    expect(() => loadConfig({ ...baseEnv, TOOLS_MAX_ARG_REPAIRS: '5' })).toThrow(/0-2/);
  });

  it('拒绝未知的工具模式', () => {
    expect(() => loadConfig({ ...baseEnv, TOOLS_MODE: 'magic' })).toThrow(ConfigError);
  });

  it('文件子系统限额有可用默认值（M6）', () => {
    const { files, upstreamImageInput } = loadConfig(baseEnv);
    expect(files.maxFileBytes).toBeGreaterThan(0);
    expect(files.maxRequestBytes).toBeGreaterThanOrEqual(files.maxFileBytes);
    expect(files.maxTotalBytesPerKey).toBeGreaterThan(files.maxFileBytes);
    expect(files.retentionMs).toBeGreaterThan(0);
    expect(files.uploadTtlMs).toBeGreaterThan(0);
    // Mặc định không giả vờ hỗ trợ nhập ảnh: Năng lực thật phải đợi probe M0 hiệu chuẩn
    expect(upstreamImageInput).toBe(false);
  });

  it('文件子系统限额可用环境变量覆盖', () => {
    const { files, upstreamImageInput } = loadConfig({
      ...baseEnv,
      FILES_MAX_FILE_BYTES: '1024',
      FILES_MAX_REQUEST_BYTES: '2048',
      FILES_MAX_TOTAL_BYTES_PER_KEY: '4096',
      FILES_RETENTION_MS: '0',
      UPSTREAM_IMAGE_INPUT: 'true',
    });
    expect(files.maxFileBytes).toBe(1024);
    expect(files.maxRequestBytes).toBe(2048);
    expect(files.maxTotalBytesPerKey).toBe(4096);
    expect(files.retentionMs).toBe(0);
    expect(upstreamImageInput).toBe(true);
  });

  it('上下文字符上限有可用默认值，且可被环境变量覆盖', () => {
    expect(loadConfig(baseEnv).contextMaxChars).toBeGreaterThan(10_000);
    expect(loadConfig({ ...baseEnv, CONTEXT_MAX_CHARS: '50000' }).contextMaxChars).toBe(50_000);
  });

  it('单请求上限不得小于单文件上限', () => {
    expect(() =>
      loadConfig({ ...baseEnv, FILES_MAX_FILE_BYTES: '2048', FILES_MAX_REQUEST_BYTES: '1024' }),
    ).toThrow(/FILES_MAX_REQUEST_BYTES/);
  });
});

describe('summarizeConfig', () => {
  it('摘要中不含主密钥与管理密码', () => {
    const config = loadConfig(baseEnv);
    const summary = JSON.stringify(summarizeConfig(config));
    expect(summary).not.toContain(validKey);
    expect(summary).not.toContain('a-sufficiently-long-password');
    expect(summary).toContain('masterKeyConfigured');
  });
});
