import type { AdminApi } from './adminApi';
import { request, requestBlob, requestMultipart } from './http';
import type {
  AccountView,
  ApiKeyCreated,
  ApiKeyView,
  AuditLogEntry,
  AuthorizeUrlResponse,
  BackupInfo,
  BackupListResponse,
  BulkImportProxyRequest,
  BulkImportProxyResult,
  CapabilitiesResponse,
  CodexConfigResponse,
  DiagnosticsReport,
  FileListResponse,
  FilesCleanupResult,
  LoginResponse,
  OAuthCallbackResult,
  OAuthSessionsResponse,
  OverviewResponse,
  ProxyCheckResult,
  ProxyView,
  RequestDetail,
  RequestListResponse,
  RestoreResult,
  SessionResponse,
  SettingsGroupName,
  SettingsResponse,
} from './types';

/**
 * Triển khai máy chủ thực tế. Đường dẫn và phương thức API tuân thủ nghiêm ngặt quy ước API quản trị.
 *
 * Chú ý một số điểm khác biệt có thể có giữa tài liệu quy ước và mã nguồn M1-M2,
 * tại đây viết theo tài liệu quy ước; nếu máy chủ giữ đường dẫn cũ cần đồng bộ khi tích hợp.
 */
export const realAdminApi: AdminApi = {
  login: (password) => request<LoginResponse>('/admin/login', { method: 'POST', body: { password } }),
  logout: () => request<void>('/admin/logout', { method: 'POST' }),
  getSession: () => request<SessionResponse>('/admin/session'),

  getOverview: () => request<OverviewResponse>('/admin/overview'),

  listAccounts: () => request<{ data: AccountView[] }>('/admin/accounts').then((r) => r.data),
  getAccount: (id) => request<AccountView>(`/admin/accounts/${id}`),
  setAccountStatus: (id, status) =>
    request<AccountView>(`/admin/accounts/${id}`, { method: 'PATCH', body: { status } }),
  refreshAccount: (id) => request<AccountView>(`/admin/accounts/${id}/refresh`, { method: 'POST' }),
  deleteAccount: (id) => request<void>(`/admin/accounts/${id}`, { method: 'DELETE' }),
  bindAccountProxy: (id, proxyId) =>
    request<AccountView>(`/admin/accounts/${id}/proxy`, { method: 'POST', body: { proxy_id: proxyId } }),

  createAuthorizeUrl: () => request<AuthorizeUrlResponse>('/admin/oauth/authorize-url', { method: 'POST' }),
  submitOAuthCallback: (callbackUrl) =>
    request<OAuthCallbackResult>('/admin/oauth/callback', {
      method: 'POST',
      body: { redirect_url: callbackUrl },
    }),
  getOAuthSessions: () => request<OAuthSessionsResponse>('/admin/oauth/sessions'),

  listRequests: ({ limit, status, apiKeyId }) =>
    request<RequestListResponse>('/admin/requests', {
      query: { limit, status, api_key_id: apiKeyId },
    }),
  getRequest: (id) => request<RequestDetail>(`/admin/requests/${id}`),

  listApiKeys: () => request<{ data: ApiKeyView[] }>('/admin/api-keys').then((r) => r.data),
  createApiKey: (payload) => request<ApiKeyCreated>('/admin/api-keys', { method: 'POST', body: payload }),
  updateApiKey: (id, payload) =>
    request<ApiKeyView>(`/admin/api-keys/${id}`, { method: 'PATCH', body: payload }),
  revokeApiKey: (id) => request<ApiKeyView>(`/admin/api-keys/${id}`, { method: 'DELETE' }),

  getCapabilities: () => request<CapabilitiesResponse>('/admin/capabilities'),

  listFiles: ({ apiKeyId, limit }) =>
    request<FileListResponse>('/admin/files', { query: { api_key_id: apiKeyId, limit } }),
  deleteFile: (id) => request<void>(`/admin/files/${id}`, { method: 'DELETE' }),
  cleanupFiles: () => request<FilesCleanupResult>('/admin/files/cleanup', { method: 'POST' }),

  listProxies: () => request<{ items: ProxyView[] }>('/admin/proxies').then((r) => r.items),
  createProxy: (payload) => request<ProxyView>('/admin/proxies', { method: 'POST', body: payload }),
  bulkImportProxies: (payload: BulkImportProxyRequest) =>
    request<BulkImportProxyResult>('/admin/proxies/bulk', { method: 'POST', body: payload }),
  updateProxy: (id, payload) => request<ProxyView>(`/admin/proxies/${id}`, { method: 'PATCH', body: payload }),
  deleteProxy: (id) => request<void>(`/admin/proxies/${id}`, { method: 'DELETE' }),
  checkProxy: (id) => request<ProxyCheckResult>(`/admin/proxies/${id}/check`, { method: 'POST' }),

  getSettings: () => request<SettingsResponse>('/admin/settings'),
  updateSettings: (group: SettingsGroupName, values) =>
    request<SettingsResponse>('/admin/settings', { method: 'PATCH', body: { group, values } }),

  getCodexConfig: (apiKeyEnv) =>
    request<CodexConfigResponse>('/admin/codex-config', { query: { api_key_env: apiKeyEnv } }),

  getAuditLogs: (limit) => request<{ data: AuditLogEntry[] }>('/admin/audit-logs', { query: { limit } }).then(
    (r) => r.data,
  ),

  // Sao lưu / Phục hồi / Chẩn đoán: đường dẫn và trường trả về xem tại apps/server/src/routes/backup.ts.
  // Ghi chú: Phía server hiện tại chưa đọc includeFiles trong body POST /admin/backup,
  // ở đây vẫn truyền theo quy ước, khi server cập nhật thì frontend không cần sửa lại.
  createBackup: (options) => request<BackupInfo>('/admin/backup', { method: 'POST', body: options ?? {} }),
  listBackups: () => request<BackupListResponse>('/admin/backup').then((r) => r.items),
  downloadBackup: (id) => requestBlob(`/admin/backup/${id}/download`),
  restoreBackup: (file) => requestMultipart<RestoreResult>('/admin/restore', 'file', file),
  getDiagnostics: () => request<DiagnosticsReport>('/admin/diagnostics'),
};
