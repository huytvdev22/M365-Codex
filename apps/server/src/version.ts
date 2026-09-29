import { createRequire } from 'node:module';

/**
 * Phiên bản ứng dụng.
 * Đọc trực tiếp từ apps/server/package.json thay vì viết hằng số thủ công.
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const APP_VERSION: string = pkg.version ?? '0.0.0';
