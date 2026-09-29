import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function OAuthSettingsPage() {
  return (
    <SettingsGroupPage
      title="OAuth"
      subtitle="Cấu hình Client ID và endpoint Microsoft OAuth (tương ứng nhóm oauth trong /admin/settings)"
      groups={[
        {
          group: 'oauth',
          heading: 'Endpoint OAuth',
          fields: [
            { key: 'client_id', label: 'Client ID', kind: 'string' },
            { key: 'redirect_uri', label: 'Địa chỉ Redirect URI (Callback)', kind: 'string', hint: 'Callback chuyển về trang nội bộ của Microsoft, dịch vụ này không cần mở ra Internet.' },
            { key: 'authorize_url', label: 'Endpoint Ủy quyền (Authorize URL)', kind: 'string' },
            { key: 'token_url', label: 'Endpoint Token (Token URL)', kind: 'string' },
            { key: 'scopes', label: 'Scope (Phân tách bằng dấu cách)', kind: 'string_list' },
          ],
        },
      ]}
    />
  );
}
