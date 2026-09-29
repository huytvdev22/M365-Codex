/**
 * Trang dự phòng khi thiếu bản build frontend.
 *
 * Trong image chính thức `apps/web/dist` chắc chắn tồn tại, trang này chỉ xuất hiện trong trường hợp "chỉ build server"
 * (ví dụ máy cục bộ chỉ chạy `npm run build --workspace @m365-codex/server`). Nó không phải bộ điều khiển thứ hai,
 * chỉ chịu trách nhiệm giải thích rõ: Giao diện quản trị chưa được build, và hướng dẫn cách build.
 */
export const FALLBACK_CONSOLE_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>M365-Codex Giao diện quản trị chưa được xây dựng</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.7 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: Canvas; color: CanvasText;
  }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  code, pre { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
  pre {
    padding: 0.9rem 1rem; border-radius: 8px; overflow-x: auto;
    background: color-mix(in srgb, CanvasText 8%, Canvas);
  }
  p { margin: 0.8rem 0; }
  .muted { opacity: 0.72; font-size: 0.92em; }
</style>
</head>
<body>
<main>
  <h1>Giao diện quản trị chưa được xây dựng</h1>
  <p>Dịch vụ server vẫn đang hoạt động bình thường, nhưng không tìm thấy sản phẩm build frontend tại <code>apps/web/dist</code>, nên không có trang để hiển thị.</p>
  <p>Vui lòng thực thi lệnh sau tại thư mục gốc của kho lưu trữ để build lại, sau đó tải lại trang này:</p>
  <pre>npm run build</pre>
  <p class="muted">Các API quản trị JSON không bị ảnh hưởng, vẫn hoạt động bình thường tại <code>/admin/*</code>; kiểm tra sức khỏe tại <code>/healthz</code> và <code>/readyz</code>.</p>
</main>
</body>
</html>
`;
