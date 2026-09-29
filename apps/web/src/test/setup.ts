import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Không cài @testing-library/jest-dom để giữ phụ thuộc tối thiểu; dùng trực tiếp DOM API + vitest matcher.
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
