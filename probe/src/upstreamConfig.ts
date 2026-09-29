import {
  DEFAULT_UPSTREAM_PATH_TEMPLATE,
  DEFAULT_UPSTREAM_PROTOCOL_VERSION,
  DEFAULT_UPSTREAM_SCENARIO,
  DEFAULT_UPSTREAM_WS_BASE,
} from '../../apps/server/dist/config/index.js';
import { buildUpstreamUrl, redactWsUrl } from '../../apps/server/dist/adapter/endpoint.js';
import { selectCodec } from '../../apps/server/dist/adapter/codecV1.js';
import type { ProbeUpstreamConfig } from './types.js';

/**
 * Cấu hình upstream của chính probe, các trường tương ứng một-một với `UpstreamConfig`
 * trong `apps/server/src/config/index.ts`. Giá trị mặc định lấy trực tiếp từ gateway, các biến môi trường `UPSTREAM_*` cùng tên và cùng nghĩa với gateway,
 * thuận tiện để trỏ probe tới mock upstream (tự test) hoặc endpoint upstream thật sau này khi thay đổi, không cần nhớ thêm một bộ tên biến khác.
 */
export function loadProbeUpstreamConfig(env: NodeJS.ProcessEnv = process.env): ProbeUpstreamConfig {
  return {
    wsBase: env.UPSTREAM_WS_BASE ?? DEFAULT_UPSTREAM_WS_BASE,
    pathTemplate: env.UPSTREAM_PATH_TEMPLATE ?? DEFAULT_UPSTREAM_PATH_TEMPLATE,
    protocolVersion: env.UPSTREAM_PROTOCOL_VERSION ?? DEFAULT_UPSTREAM_PROTOCOL_VERSION,
    heartbeatIntervalMs: numberEnv(env.UPSTREAM_HEARTBEAT_INTERVAL_MS, 15_000),
    handshakeTimeoutMs: numberEnv(env.UPSTREAM_HANDSHAKE_TIMEOUT_MS, 15_000),
    idleTimeoutMs: numberEnv(env.UPSTREAM_IDLE_TIMEOUT_MS, 60_000),
    scenario: env.UPSTREAM_SCENARIO ?? DEFAULT_UPSTREAM_SCENARIO,
  };
}

function numberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildProbeUrl(
  config: ProbeUpstreamConfig,
  account: { oid: string; tid: string },
  accessToken: string,
  extraParams?: Record<string, string>,
): string {
  return buildUpstreamUrl({
    config: {
      wsBase: config.wsBase,
      pathTemplate: config.pathTemplate,
      protocolVersion: config.protocolVersion,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      maxReconnects: 0,
      scenario: config.scenario,
    },
    oid: account.oid,
    tid: account.tid,
    accessToken,
    extraParams,
  });
}

export { redactWsUrl, selectCodec };
