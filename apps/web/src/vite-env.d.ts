/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Đặt thành "1" khi muốn dùng dữ liệu giả lập từ src/api/mock.ts để phát triển độc lập không cần server. */
  readonly VITE_USE_MOCK?: string;
  /** Mục tiêu proxy khi phát triển, ghi đè giá trị mặc định http://127.0.0.1:8080 trong vite.config.ts. */
  readonly VITE_API_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
