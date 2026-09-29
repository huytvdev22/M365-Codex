import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { SystemSettingsPage } from '../pages/SystemSettingsPage';
import type { SettingsResponse } from '../api';

/**
 * Mục cài đặt source=env là cố định bởi môi trường, giao diện vô hiệu hóa chỉnh sửa.
 */
const settingsFixture: SettingsResponse = {
  network: {
    public_api_base_url: { value: 'http://192.168.0.5:8080/v1', source: 'env', editable: false, requires_restart: true },
    public_admin_url: { value: 'http://192.168.0.5:8080/admin', source: 'db', editable: true, requires_restart: true },
    trust_proxy: { value: false, source: 'default', editable: true, requires_restart: true },
    http_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
    https_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
    no_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
  },
  scheduler: {
    cleanup_interval_ms: { value: 300_000, source: 'default', editable: true, requires_restart: true },
    response_retention_ms: { value: 604_800_000, source: 'default', editable: true, requires_restart: true },
    audit_log_retention_ms: { value: 2_592_000_000, source: 'default', editable: true, requires_restart: true },
    idempotency_retention_ms: { value: 86_400_000, source: 'default', editable: true, requires_restart: true },
    files_retention_ms: { value: 259_200_000, source: 'default', editable: true, requires_restart: true },
    files_upload_ttl_ms: { value: 3_600_000, source: 'default', editable: true, requires_restart: true },
  },
  logging: {
    log_level: { value: 'info', source: 'default', editable: true, requires_restart: false },
    log_privacy_mode: { value: 'strict', source: 'default', editable: true, requires_restart: true },
  },
  oauth: {
    client_id: { value: 'client-id', source: 'default', editable: true, requires_restart: true },
    redirect_uri: { value: 'https://login.microsoftonline.com/common/oauth2/nativeclient', source: 'default', editable: true, requires_restart: true },
    authorize_url: { value: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', source: 'default', editable: true, requires_restart: true },
    token_url: { value: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', source: 'default', editable: true, requires_restart: true },
    scopes: { value: ['openid', 'profile'], source: 'default', editable: true, requires_restart: true },
  },
  tools: {
    mode: { value: 'auto', source: 'default', editable: true, requires_restart: true },
    max_calls_per_round: { value: 4, source: 'default', editable: true, requires_restart: true },
    max_rounds: { value: 8, source: 'default', editable: true, requires_restart: true },
    max_total_calls: { value: 32, source: 'default', editable: true, requires_restart: true },
    max_result_bytes: { value: 65_536, source: 'default', editable: true, requires_restart: true },
    max_arg_repairs: { value: 2, source: 'default', editable: true, requires_restart: true },
    allow_parallel: { value: true, source: 'default', editable: true, requires_restart: true },
  },
  files: {
    max_file_bytes: { value: 20_971_520, source: 'default', editable: true, requires_restart: true },
    max_request_bytes: { value: 52_428_800, source: 'default', editable: true, requires_restart: true },
    max_total_bytes_per_key: { value: 524_288_000, source: 'default', editable: true, requires_restart: true },
  },
};

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      ...actual.api,
      getSettings: () => Promise.resolve(settingsFixture),
    },
  };
});

describe('Hiển thị vô hiệu hóa của source=env trong trang cài đặt', () => {
  it('Trường có nguồn env được render ở dạng vô hiệu hóa và có thông báo sửa không có hiệu lực', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/system']}>
        <AuthProvider>
          <SystemSettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const input = (await screen.findByLabelText(/Base URL API đối ngoại/)) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('http://192.168.0.5:8080/v1');

    expect(screen.getAllByText('Được cố định bởi biến môi trường, sửa tại đây sẽ không có hiệu lực.').length).toBeGreaterThan(0);

    // Cùng nhóm nhưng source=db vẫn có thể chỉnh sửa
    const adminUrlInput = (await screen.findByLabelText(/Địa chỉ công khai giao diện quản trị/)) as HTMLInputElement;
    expect(adminUrlInput.disabled).toBe(false);
  });

  it('Ô nhập max_arg_repairs giới hạn trong khoảng 0-2 theo quy tắc giao thức', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/system']}>
        <AuthProvider>
          <SystemSettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const input = (await screen.findByLabelText(/Số lần sửa tham số tối đa/)) as HTMLInputElement;
    expect(input.min).toBe('0');
    expect(input.max).toBe('2');
    expect(screen.getByText(/Quy tắc giao thức giới hạn tối đa 2 lần/)).toBeTruthy();
  });
});
