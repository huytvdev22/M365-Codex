import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Mục tiêu proxy phát triển có thể ghi đè bằng VITE_API_TARGET, mặc định trỏ về cổng 8080 (cổng mặc định của server).
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, '.', '');
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8080';

  return {
    // Build production mount tại /ui/ (server phục vụ tĩnh, /admin/* dành cho JSON API quản trị,
    // tránh việc cùng prefix nửa là trang web nửa là API); Chế độ dev giữ ở root path,
    // để các quy tắc proxy /admin, /v1 không xung đột với tài nguyên của chính web app.
    base: command === 'build' ? '/ui/' : '/',
    plugins: [react()],
    server: {
      proxy: {
        '/admin': { target: apiTarget, changeOrigin: true },
        '/v1': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
