import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Cấu hình phẳng ESLint.
 *
 * Các quy tắc nhận biết kiểu dữ liệu (type-aware) chỉ áp dụng cho `src` (nằm trong dự án tsconfig);
 * các tệp kiểm thử dùng quy tắc không nhận biết kiểu, tính đúng đắn về kiểu được đảm bảo riêng bởi
 * tsconfig.test.json trong `npm run typecheck`.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Hợp đồng handler / hook của Fastify là "trả về Promise", rất nhiều handler vốn không có await,
      // ép buộc viết lại thành hàm đồng bộ chỉ làm phong cách routing bị phân mảnh
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Dưới dev/ là các script độc lập dùng cho phát triển và nghiệm thu (mock upstream, seed tài khoản giả),
    // không đưa vào image production, cũng không nằm trong bất kỳ dự án tsconfig nào; chỉ cần kiểm tra bằng quy tắc không nhận biết kiểu
    files: ['dev/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Các file .mjs này không thuộc bất kỳ dự án tsconfig nào, bắt buộc phải tắt projectService,
      // nếu không parser sẽ báo lỗi cú pháp do "không tìm thấy dự án trực thuộc"
      parserOptions: { projectService: false, project: false },
      // Ở đây không import gói globals, chỉ khai báo các biến toàn cục Node thực tế được dùng trong các script này
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        // fetch tích hợp sẵn của Node 18+ và các kiểu đi kèm, script nghiệm thu dùng để gửi yêu cầu
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Các script này là công cụ dòng lệnh, xuất dữ liệu hoàn toàn bằng console
      'no-console': 'off',
    },
  },
  {
    files: ['**/test/**/*.ts', '**/test/**/*.tsx', '**/*.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      // Trải các quy tắc tắt mặc định của disableTypeChecked, sau đó chồng thêm các quy tắc nới lỏng của dự án,
      // viết trực tiếp rules sẽ ghi đè toàn bộ kết quả trải ở trên
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Trong test, `vi.importActual<typeof import('../api')>()` là cách viết chuẩn của Vitest,
      // chú thích kiểu import() nội dòng ở đây không có dạng import type tương đương, cho phép bỏ qua
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],
    },
  },
);
