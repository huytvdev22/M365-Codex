#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../apps/server/dist/observability/logger.js';
import { selectCodec } from '../../apps/server/dist/adapter/codecV1.js';
import { openAccountSource } from './accountSource.js';
import { loadProbeUpstreamConfig } from './upstreamConfig.js';
import { maskEmail, maskId } from './evidence.js';
import { ALL_CASES } from './cases/index.js';
import { writeReportFiles, type AccountRunResult } from './report.js';
import type { CapabilityResult, ProbeContext } from './types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
const PROBE_VERSION = pkg.version ?? '0.0.0';

const RISK_NOTICE = `
⚠️  风险提示（务必先读）
M365-Codex 依赖的上游是未公开、逆向得到的 Sydney/BizChat WebSocket 协议，且需要使用
你自己的 Microsoft 账号令牌。这种用法很可能违反 Microsoft 服务条款，可能触发账号风控、
能力变更甚至封禁；上游协议随时可能变化导致探测失败。本工具与其报告不构成任何官方
兼容承诺，仅供本人学习与自用评估。请只对你本人有权使用的账号与数据操作。

必须显式加上 --i-understand-the-risk 参数才会真正发起对上游的探测。
`;

interface CliArgs {
  db: string;
  account: string | null;
  all: boolean;
  refreshFirst: boolean;
  repeat: number;
  delayMs: number;
  invocationTimeoutMs: number;
  understoodRisk: boolean;
  list: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  return {
    db: get('db') ?? './data/m365-codex.sqlite',
    account: get('account') ?? null,
    all: has('all'),
    refreshFirst: has('refresh-first'),
    repeat: Number(get('repeat') ?? '20'),
    delayMs: Number(get('delay-ms') ?? '1000'),
    invocationTimeoutMs: Number(get('invocation-timeout-ms') ?? '60000'),
    understoodRisk: has('i-understand-the-risk'),
    list: has('list'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ level: 'info', privacyMode: 'strict', pretty: true });

  const masterKeyRaw = process.env.M365_CODEX_MASTER_KEY;
  if (masterKeyRaw === undefined || masterKeyRaw.trim() === '') {
    logger.error('缺少环境变量 M365_CODEX_MASTER_KEY（需要与网关一致的主密钥，用于解密账号 Token）。');
    process.exitCode = 1;
    return;
  }

  const source = openAccountSource({
    dbPath: args.db,
    masterKeyBase64: masterKeyRaw,
    masterKeyVersion: Number(process.env.MASTER_KEY_VERSION ?? '1'),
    logger,
  });

  try {
    const accountViews = source.accounts.listViews();

    if (args.list || (args.account === null && !args.all)) {
      logger.info(RISK_NOTICE);
      if (accountViews.length === 0) {
        logger.info('数据库里没有任何账号。请先通过网关的 PKCE 授权流程添加账号。');
        return;
      }
      const accountLines = accountViews
        .map((view) => `  - id=${view.id}  邮箱=${maskEmail(view.email)}  tid=${maskId(view.tid) ?? '(无)'}  状态=${view.status}`)
        .join('\n');
      logger.info(`可选账号：\n${accountLines}`);
      logger.info('用 --account <id> 跑指定账号，或 --all 跑全部账号（都需要加 --i-understand-the-risk）。');
      return;
    }

    if (!args.understoodRisk) {
      logger.info(RISK_NOTICE);
      logger.error('未加 --i-understand-the-risk，探针不会发起任何真实上游请求。');
      process.exitCode = 1;
      return;
    }

    const targets = args.all
      ? accountViews
      : accountViews.filter((v) => v.id === args.account);

    if (targets.length === 0) {
      logger.error(`没有找到匹配的账号：${args.account ?? '(未指定)'}`);
      process.exitCode = 1;
      return;
    }

    const upstream = loadProbeUpstreamConfig();
    const codec = selectCodec(upstream.protocolVersion);

    const accountRuns: AccountRunResult[] = [];

    for (const view of targets) {
      if (args.refreshFirst) {
        logger.info({ account_id: view.id }, '按 --refresh-first 要求，先刷新一次 Token');
        try {
          await source.tokenManager.refresh(view.id);
        } catch (error) {
          logger.warn(
            { account_id: view.id, error: error instanceof Error ? error.message : String(error) },
            '预刷新失败，继续用现有 Token 探测',
          );
        }
      }

      const ctx: ProbeContext = {
        account: { id: view.id, oid: view.oid, tid: view.tid, email: view.email },
        getAccessToken: async () => {
          const current = source.accounts.readAccessToken(view.id);
          if (current === null) throw new Error(`账号 ${view.id} 没有可用的 access token`);
          return current.token;
        },
        upstream,
        codec,
        logger,
        delayMs: args.delayMs,
        repeat: Math.max(1, args.repeat),
        invocationTimeoutMs: args.invocationTimeoutMs,
        accounts: source.accounts,
        oauthClient: source.oauthClient,
        tokenManager: source.tokenManager,
      };

      const results: CapabilityResult[] = [];
      for (const [caseIndex, caseDef] of ALL_CASES.entries()) {
        logger.info({ account_id: view.id, case: caseDef.id }, `跑第 ${caseDef.index} 项：${caseDef.name}`);
        const result = await caseDef.run(ctx);
        results.push(result);
        if (caseIndex < ALL_CASES.length - 1) await sleep(args.delayMs);
      }

      accountRuns.push({
        label: `${maskEmail(view.email)} · tid=${maskId(view.tid) ?? '(无)'} · ${view.id.slice(0, 8)}`,
        results,
      });
    }

    const outDir = process.env.PROBE_OUT_DIR ?? fileURLToPath(new URL('../out/', import.meta.url));
    const { markdownPath, jsonPath } = writeReportFiles(outDir, {
      generatedAt: Date.now(),
      toolVersion: PROBE_VERSION,
      accounts: accountRuns,
    });

    logger.info(`报告已生成：\n  ${markdownPath}\n  ${jsonPath}`);
  } finally {
    source.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  // Log dự phòng: Lúc này pino logger có thể chưa tạo thành công (như thất bại ở giai đoạn parse config), dùng trực tiếp stderr
  process.stderr.write(`探针运行失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
