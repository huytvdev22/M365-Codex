import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';

describe('ErrorBanner hiển thị lỗi thống nhất', () => {
  it('Hiển thị thông tin lỗi và request_id hỗ trợ xử lý sự cố', () => {
    const error = new ApiRequestError(400, {
      error: {
        type: 'invalid_request_error',
        message: 'expires_at phải muộn hơn starts_at',
        param: 'expires_at',
        request_id: 'req_abc123',
      },
    });

    render(<ErrorBanner error={error} />);

    expect(screen.getByText('Yêu cầu không hợp lệ')).toBeTruthy();
    expect(screen.getByText('expires_at phải muộn hơn starts_at')).toBeTruthy();
    expect(screen.getByText(/req_abc123/)).toBeTruthy();
    expect(screen.getAllByText(/expires_at/).length).toBeGreaterThan(0);
  });

  it('error trống thì không render nội dung', () => {
    const { container } = render(<ErrorBanner error={null} />);
    expect(container.textContent).toBe('');
  });

  it('Ngoại lệ thông thường ngoài ApiRequestError cũng hiển thị thân thiện', () => {
    render(<ErrorBanner error={new Error('Mất kết nối mạng')} />);
    expect(screen.getByText('Đã xảy ra lỗi')).toBeTruthy();
    expect(screen.getByText('Mất kết nối mạng')).toBeTruthy();
  });
});
