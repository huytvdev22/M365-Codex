import { pino, type Logger, type LoggerOptions } from 'pino';
import type { LogPrivacyMode } from '@m365-codex/shared';

/**
 * Log và chế độ riêng tư (tương ứng kế hoạch triển khai §1.1, §3).
 *
 * Ba mức độ chế độ riêng tư:
 * - `strict` (mặc định): không ghi lại request body, prompt, nội dung upstream; IP chỉ ghi lại dải mạng;
 * - `metadata`: ghi thêm metadata như tên mô hình, độ dài, thời gian tiêu tốn, vẫn không ghi lại văn bản nội dung;
 * - `debug`: ghi lại nhiều chi tiết có cấu trúc hơn, chỉ dùng để điều tra sự cố cục bộ; các trường thông tin xác thực luôn được làm mờ trong mọi chế độ.
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'authorization',
  'password',
  'api_key',
  'apiKey',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'client_secret',
  'code_verifier',
  'master_key',
  'masterKey',
  'token',
  '*.access_token',
  '*.refresh_token',
  '*.password',
  '*.token',
];

const REDACT_CENSOR = '[已脱敏]';

export interface CreateLoggerOptions {
  level: string;
  privacyMode: LogPrivacyMode;
  /** Môi trường phát triển bật output có màu, trong container giữ JSON */
  pretty?: boolean;
  /** Chuyển hướng output trong test */
  destination?: NodeJS.WritableStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.level,
    base: { privacy_mode: options.privacyMode },
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (options.destination !== undefined) {
    return pino(base, options.destination);
  }

  if (options.pretty === true) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(base);
}

/**
 * Xử lý IP của client theo chế độ riêng tư:
 * strict chỉ giữ lại dải mạng (IPv4 /24, IPv6 /48), các chế độ khác giữ nguyên địa chỉ đầy đủ.
 */
export function maskIp(ip: string | undefined, mode: LogPrivacyMode): string | null {
  if (ip === undefined || ip === '') return null;
  if (mode !== 'strict') return ip;

  if (ip.includes(':')) {
    const groups = ip.split(':').filter((part) => part !== '');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/** Chế độ strict chỉ cho phép ghi lại thông tin phái sinh như độ dài, nghiêm cấm ghi nguyên văn. */
export function describeText(text: string | undefined, mode: LogPrivacyMode): Record<string, unknown> {
  if (text === undefined) return { present: false };
  if (mode === 'debug') return { present: true, length: text.length, sample: text.slice(0, 200) };
  return { present: true, length: text.length };
}
