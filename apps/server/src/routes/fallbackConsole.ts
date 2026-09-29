/**
 * Trang dự phòng khi thiếu bản build frontend.
 *
 * Trong image chính thức `apps/web/dist` chắc chắn tồn tại, trang này chỉ xuất hiện trong trường hợp "chỉ build server"
 * (ví dụ máy cục bộ chỉ chạy `npm run build --workspace @m365-codex/server`). Nó không phải bộ điều khiển thứ hai,
 * chỉ chịu trách nhiệm giải thích rõ: Giao diện quản trị chưa được build, và hướng dẫn cách build.
 */
export const FALLBACK_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>M365-Codex 管理界面未构建</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
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
  <h1>管理界面尚未构建</h1>
  <p>服务本身运行正常，但没有找到前端构建产物 <code>apps/web/dist</code>，所以这里没有页面可以显示。</p>
  <p>在仓库根目录执行下面的命令重新构建，然后刷新本页：</p>
  <pre>npm run build</pre>
  <p class="muted">JSON 管理接口不受影响，仍在 <code>/admin/*</code> 下可用；健康检查见 <code>/healthz</code> 与 <code>/readyz</code>。</p>
</main>
</body>
</html>
`;
