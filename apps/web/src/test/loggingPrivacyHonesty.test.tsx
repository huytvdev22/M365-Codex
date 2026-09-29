import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { LoggingSettingsPage } from '../pages/LoggingSettingsPage';
import type { SettingsResponse } from '../api';

/**
 * Kiểm tra văn bản mô tả chế độ riêng tư log không hứa hẹn tính năng tự động hết hạn không có thực.
 */

const settingsFixture: SettingsResponse = {
  network: {
    public_api_base_url: { value: 'http://192.168.0.5:8080/v1', source: 'db', editable: true, requires_restart: true },
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

describe('Mô tả chế độ riêng tư log trung thực', () => {
  it('Không còn cam kết sai về tự động hết hạn, thông báo rõ cần chuyển lại thủ công', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/logging']}>
        <AuthProvider>
          <LoggingSettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByLabelText(/Chế độ riêng tư/);

    expect(document.body.textContent?.includes('tự động hết hạn')).toBe(false);
    expect(document.body.textContent?.includes('tự động phục hồi')).toBe(false);
    expect(screen.getByText(/không tự động chuyển về/)).toBeTruthy();
    expect(screen.getByText(/bắt buộc phải chuyển lại thủ công/)).toBeTruthy();
  });
});
