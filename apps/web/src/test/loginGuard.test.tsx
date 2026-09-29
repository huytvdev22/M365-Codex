import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';

/**
 * Bộ bảo vệ đăng nhập: Khi không có phiên làm việc, truy cập bất kỳ đường dẫn nào đều chuyển về trang đăng nhập.
 */
describe('Bộ bảo vệ đăng nhập', () => {
  it('Chưa đăng nhập truy cập trang tổng quan sẽ bị chuyển hướng về trang đăng nhập', async () => {
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Đăng nhập Quản trị viên')).toBeTruthy();
    expect(screen.queryByText('Tổng quan')).toBeNull();
  });

  it('Chưa đăng nhập truy cập trang API Key sẽ bị chuyển hướng về trang đăng nhập', async () => {
    render(
      <MemoryRouter initialEntries={['/api-keys']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Đăng nhập Quản trị viên')).toBeTruthy();
  });
});
