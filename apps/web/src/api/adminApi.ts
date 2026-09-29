import type {
  AccountStatus,
  AccountView,
  ApiKeyCreated,
  ApiKeyView,
  AuditLogEntry,
  AuthorizeUrlResponse,
  BackupInfo,
  BulkImportProxyRequest,
  BulkImportProxyResult,
  CapabilitiesResponse,
  CodexConfigResponse,
  CreateApiKeyRequest,
  CreateProxyRequest,
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
  UpdateApiKeyRequest,
} from './types';

/**
 * Toàn bộ năng lực quản trị mà WebUI sử dụng. Cả bản triển khai thực tế (client.ts) và giả lập (mock.ts)
 * đều triển khai cùng một giao diện này, mã giao diện không cần quan tâm đang chạy bản nào.
 */
export interface AdminApi {
  login(password: string): Promise<LoginResponse>;
  logout(): Promise<void>;
  getSession(): Promise<SessionResponse>;

  getOverview(): Promise<OverviewResponse>;

  listAccounts(): Promise<AccountView[]>;
  getAccount(id: string): Promise<AccountView>;
  setAccountStatus(id: string, status: AccountStatus): Promise<AccountView>;
  refreshAccount(id: string): Promise<AccountView>;
  deleteAccount(id: string): Promise<void>;
  bindAccountProxy(id: string, proxyId: string | null): Promise<AccountView>;

  createAuthorizeUrl(): Promise<AuthorizeUrlResponse>;
  submitOAuthCallback(callbackUrl: string): Promise<OAuthCallbackResult>;
  getOAuthSessions(): Promise<OAuthSessionsResponse>;

  listRequests(params: { limit?: number; status?: string; apiKeyId?: string }): Promise<RequestListResponse>;
  getRequest(id: string): Promise<RequestDetail>;

  listApiKeys(): Promise<ApiKeyView[]>;
  createApiKey(payload: CreateApiKeyRequest): Promise<ApiKeyCreated>;
  updateApiKey(id: string, payload: UpdateApiKeyRequest): Promise<ApiKeyView>;
  revokeApiKey(id: string): Promise<ApiKeyView>;

  getCapabilities(): Promise<CapabilitiesResponse>;

  listFiles(params: { apiKeyId?: string; limit?: number }): Promise<FileListResponse>;
  deleteFile(id: string): Promise<void>;
  cleanupFiles(): Promise<FilesCleanupResult>;

  listProxies(): Promise<ProxyView[]>;
  createProxy(payload: CreateProxyRequest): Promise<ProxyView>;
  bulkImportProxies(payload: BulkImportProxyRequest): Promise<BulkImportProxyResult>;
  updateProxy(id: string, payload: Partial<CreateProxyRequest>): Promise<ProxyView>;
  deleteProxy(id: string): Promise<void>;
  checkProxy(id: string): Promise<ProxyCheckResult>;

  getSettings(): Promise<SettingsResponse>;
  updateSettings(group: SettingsGroupName, values: Record<string, unknown>): Promise<SettingsResponse>;

  getCodexConfig(apiKeyEnv: string): Promise<CodexConfigResponse>;

  getAuditLogs(limit?: number): Promise<AuditLogEntry[]>;

  createBackup(options?: { includeFiles?: boolean }): Promise<BackupInfo>;
  listBackups(): Promise<BackupInfo[]>;
  downloadBackup(id: string): Promise<Blob>;
  restoreBackup(file: File): Promise<RestoreResult>;
  getDiagnostics(): Promise<DiagnosticsReport>;
}
