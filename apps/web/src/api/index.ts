import type { AdminApi } from './adminApi';
import { realAdminApi } from './client';
import { mockAdminApi } from './mock';

/**
 * Khi `VITE_USE_MOCK=1`, toàn trang chuyển sang dữ liệu giả lập trong bộ nhớ để phát triển/chạy test độc lập;
 * Mặc định (chưa đặt hoặc giá trị khác) sẽ kết nối backend thực tế. Mã giao diện import thống nhất `api` từ đây.
 */
export const api: AdminApi = import.meta.env.VITE_USE_MOCK === '1' ? mockAdminApi : realAdminApi;

export * from './types';
export type { AdminApi } from './adminApi';
