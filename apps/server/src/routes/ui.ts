import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { FALLBACK_CONSOLE_HTML } from './fallbackConsole.js';

/**
 * Hosting tĩnh cho giao diện quản trị (tương ứng kế hoạch triển khai §14).
 *
 * Các trang được gắn dưới `/ui/`, tách biệt với JSON API quản lý `/admin/*` — nếu chung một tiền tố mà nửa là trang
 * nửa là JSON thì việc bổ sung endpoint sau này rất dễ bị xung đột đường dẫn.
 *
 * Không đưa thêm @fastify/static vào: Ở đây chỉ cần "đọc tệp + gán Content-Type theo đuôi mở rộng + phòng chống
 * path traversal + fallback SPA", tự viết 40 dòng kinh tế hơn là thêm một dependency.
 *
 * Khi sản phẩm build không tồn tại (ví dụ chỉ build server), fallback về trang **bảng điều khiển tạm thời** tích hợp sẵn,
 * đảm bảo quản trị viên lúc nào cũng vào được, thêm được tài khoản, tạo được Key. Một khi sản phẩm build xuất hiện sẽ tự động tiếp quản.
 */

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Xác định vị trí apps/web/dist: Độ sâu tương đối của dist/routes/ui.js và mã nguồn src/routes/ui.ts là như nhau. */
function resolveWebDist(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', '..', 'web', 'dist');
}

export function registerUiRoutes(app: FastifyInstance, options: { webDist?: string } = {}): void {
  const webDist = options.webDist ?? resolveWebDist();

  app.get('/', async (_request, reply) => {
    return reply.redirect('/ui/', 302);
  });

  app.get('/ui', async (_request, reply) => {
    return reply.redirect('/ui/', 302);
  });

  app.get<{ Params: { '*': string } }>('/ui/*', async (request, reply) => {
    const requested = request.params['*'] ?? '';

    if (!existsSync(join(webDist, 'index.html'))) {
      // Chưa có sản phẩm build frontend: Trả về trang bảng điều khiển tạm tích hợp sẵn
      return reply.type('text/html; charset=utf-8').send(FALLBACK_CONSOLE_HTML);
    }

    // Phòng chống path traversal: Đường dẫn sau khi ghép phải luôn nằm trong webDist
    const candidate = resolve(webDist, normalize(requested));
    const inside = candidate === webDist || candidate.startsWith(webDist + sep);
    const target = inside && requested !== '' && existsSync(candidate) ? candidate : join(webDist, 'index.html');

    const body = await readFile(target);
    const mime = MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream';
    // Tài nguyên có hash có thể cache lâu, index.html thì không — nếu không sau khi cập nhật trình duyệt sẽ giữ mãi vỏ cũ
    const cache = target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
    return reply.type(mime).header('cache-control', cache).send(body);
  });
}
