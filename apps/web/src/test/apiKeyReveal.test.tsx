import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { ApiKeysPage } from '../pages/ApiKeysPage';
import type { ApiKeyCreated, ApiKeyView } from '../api';

const PLAINTEXT_KEY = 'sk-TESTONLYNOTREALSECRETVALUE0000000000000000';

const listApiKeys = vi.fn<() => Promise<ApiKeyView[]>>();
const createApiKey = vi.fn<(payload: unknown) => Promise<ApiKeyCreated>>();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listApiKeys: (...args: []) => listApiKeys(...args),
      createApiKey: (...args: [unknown]) => createApiKey(...args),
    },
  };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/api-keys']}>
      <AuthProvider>
        <ApiKeysPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('Khóa API dạng văn bản rõ chỉ hiển thị một lần', () => {
  beforeEach(() => {
    listApiKeys.mockReset().mockResolvedValue([]);
    createApiKey.mockReset();
  });

  it('Sau khi tạo popup hiển thị khóa rõ, trước khi đóng phải tích chọn đã lưu, sau khi đóng danh sách chỉ còn khóa che', async () => {
    const created: ApiKeyCreated = {
      id: 'key_new',
      name: 'Khóa thử nghiệm',
      masked_key: 'sk-Ab12************wxYZ',
      enabled: true,
      created_at: Date.now(),
      starts_at: null,
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      rpm_limit: null,
      daily_limit: null,
      max_concurrency: null,
      allowed_endpoints: null,
      allowed_models: null,
      key: PLAINTEXT_KEY,
    };
    createApiKey.mockResolvedValue(created);
    listApiKeys
      .mockResolvedValueOnce([]) // Tải lần đầu
      .mockResolvedValueOnce([created]); // Làm mới sau khi tạo

    renderPage();

    const nameInput = await screen.findByLabelText('Tên gợi nhớ');
    fireEvent.change(nameInput, { target: { value: 'Khóa thử nghiệm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo mới' }));

    // Khóa rõ chỉ xuất hiện 1 lần trong modal
    await screen.findByText(PLAINTEXT_KEY);
    expect(screen.getByText('Đây là lần duy nhất hiển thị toàn bộ khóa bí mật')).toBeTruthy();

    const closeButton = screen.getByRole('button', { name: 'Đóng' });
    // Chưa tích chọn "Tôi đã lưu lại khóa bí mật này" thì nút đóng bị vô hiệu hóa
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Tôi đã lưu lại khóa bí mật này'));
    expect((closeButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.queryByText(PLAINTEXT_KEY)).toBeNull();
    });
    // Sau khi đóng, trang danh sách chỉ hiển thị khóa che, văn bản rõ không tồn tại trong DOM
    expect(screen.getByText(created.masked_key)).toBeTruthy();
    expect(document.body.textContent?.includes(PLAINTEXT_KEY)).toBe(false);
  });
});
