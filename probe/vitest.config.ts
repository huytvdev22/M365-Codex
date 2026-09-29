import { defineConfig } from 'vitest/config';

/**
 * Cấu hình tự kiểm thử của probe.
 *
 * Tự kiểm thử chỉ gọi mock upstream khởi tạo từ `apps/server/test/helpers/mockSydneyServer.ts`,
 * tuyệt đối không kết nối Microsoft thật; do đó ở đây không cần bất kỳ thiết lập mạng thật nào.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
});
