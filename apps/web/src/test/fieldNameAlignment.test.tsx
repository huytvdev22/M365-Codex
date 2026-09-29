import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { ProxiesPage } from '../pages/ProxiesPage';
import { FilesPage } from '../pages/FilesPage';
import type { BulkImportProxyResult, FileListItem, FilesCleanupResult } from '../api';

/**
 * Kiểm tra các trường trả về thực tế từ server được render chính xác, không bị undefined.
 */

const listProxies = vi.fn<() => Promise<[]>>();
const bulkImportProxies = vi.fn<(payload: unknown) => Promise<BulkImportProxyResult>>();
const listFiles = vi.fn<() => Promise<{ items: FileListItem[]; total_bytes: number }>>();
const cleanupFiles = vi.fn<() => Promise<FilesCleanupResult>>();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listProxies: (...args: []) => listProxies(...args),
      bulkImportProxies: (...args: [unknown]) => bulkImportProxies(...args),
      listFiles: (...args: []) => listFiles(...args),
      cleanupFiles: (...args: []) => cleanupFiles(...args),
    },
  };
});

describe('Kết quả nhập proxy hàng loạt khớp với server', () => {
  beforeEach(() => {
    listProxies.mockReset().mockResolvedValue([]);
    bulkImportProxies.mockReset();
  });

  it('Render đúng cấu trúc {created, failed, results} từ server, không xuất hiện undefined', async () => {
    bulkImportProxies.mockResolvedValue({
      created: 1,
      failed: 1,
      results: [
        { line: 'http://1.2.3.4:8080', ok: true, id: 'proxy_9' },
        { line: 'not-a-url', ok: false, error: 'url không phải là URL hợp lệ' },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/proxies']}>
        <AuthProvider>
          <ProxiesPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const textarea = await screen.findByLabelText('Mỗi dòng một địa chỉ URL');
    fireEvent.change(textarea, { target: { value: 'http://1.2.3.4:8080\nnot-a-url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nhập hàng loạt' }));

    await screen.findByText('Thành công 1 mục, thất bại 1 mục');
    expect(screen.getByText(/url không phải là URL hợp lệ/)).toBeTruthy();
    expect(document.body.textContent?.includes('undefined')).toBe(false);
  });
});

describe('Kết quả dọn dẹp tệp khớp với server', () => {
  beforeEach(() => {
    listFiles.mockReset().mockResolvedValue({ items: [], total_bytes: 0 });
    cleanupFiles.mockReset();
  });

  it('Render đúng cấu trúc {deleted_files, deleted_uploads, freed_bytes} từ server, không xuất hiện undefined', async () => {
    cleanupFiles.mockResolvedValue({ deleted_files: 3, deleted_uploads: 2, freed_bytes: 5_242_880 });

    render(
      <MemoryRouter initialEntries={['/files']}>
        <AuthProvider>
          <FilesPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Dọn dẹp ngay' }));

    await screen.findByText(/Đợt trước đã xóa 3 tệp, 2 lượt tải dang dở/);
    expect(screen.getByText(/5\.00 MB/)).toBeTruthy();
    expect(document.body.textContent?.includes('undefined')).toBe(false);
  });
});
