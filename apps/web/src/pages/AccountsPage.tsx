import { useState } from 'react';
import { Link } from 'react-router';
import { api, type AccountStatus, type AccountView } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { AccountStatusBadge, BoolBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime, formatRelative } from '../util/format';

const NEXT_STATUS: Partial<Record<AccountStatus, { label: string; next: AccountStatus }>> = {
  disabled: { label: 'Bật', next: 'probing' },
  online: { label: 'Tắt', next: 'disabled' },
  busy: { label: 'Tắt', next: 'disabled' },
  cooldown: { label: 'Tắt', next: 'disabled' },
  error: { label: 'Tắt', next: 'disabled' },
};

export function AccountsPage() {
  const { data, error, loading, reload } = useAsync(() => api.listAccounts());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

  const runAction = (id: string, action: () => Promise<AccountView>) => {
    setBusyId(id);
    setRowError(null);
    action()
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleDelete = (account: AccountView) => {
    if (!window.confirm(`Xác nhận xóa tài khoản "${account.display_name ?? account.email ?? account.id}"? Thao tác này không thể hoàn tác.`)) {
      return;
    }
    setBusyId(account.id);
    api
      .deleteAccount(account.id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: account.id, error: err }))
      .finally(() => setBusyId(null));
  };

  return (
    <Layout title="Tài khoản Microsoft" subtitle="Quản lý trạng thái và vòng đời nhóm tài khoản">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <span className="text-muted">
          Tổng cộng {data?.length ?? 0} tài khoản. Để thêm mới, vui lòng vào{' '}
          <Link to="/accounts/add">Thêm tài khoản</Link>.
        </span>
        <button type="button" className="btn btn-sm" onClick={reload}>
          Làm mới
        </button>
      </div>
      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(list) => list.length === 0}
        emptyTitle="Chưa có tài khoản nào"
        emptyHint="Vào mục «Thêm tài khoản» để bắt đầu quy trình ủy quyền PKCE."
      >
        {(accounts) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tài khoản</th>
                  <th>Trạng thái</th>
                  <th>Refresh Token</th>
                  <th>Thành công gần nhất</th>
                  <th>Thất bại liên tiếp</th>
                  <th>Token hết hạn</th>
                  <th>Proxy gán kèm</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const action = NEXT_STATUS[account.status];
                  return (
                    <tr key={account.id}>
                      <td>
                        <div>{account.display_name ?? '(Chưa đặt tên)'}</div>
                        <div className="text-faint mono">{account.email ?? account.id}</div>
                      </td>
                      <td>
                        <AccountStatusBadge status={account.status} />
                      </td>
                      <td>
                        <BoolBadge value={account.has_refresh_token} trueLabel="Hợp lệ" falseLabel="Thiếu" />
                      </td>
                      <td>{formatRelative(account.last_ok_at)}</td>
                      <td>{account.consecutive_failures}</td>
                      <td title={formatDateTime(account.token_expires_at)}>
                        {formatRelative(account.token_expires_at)}
                      </td>
                      <td>{account.proxy_id ?? <span className="text-faint">Chưa gán</span>}</td>
                      <td>
                        <div className="flex gap-8">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyId === account.id}
                            onClick={() => runAction(account.id, () => api.refreshAccount(account.id))}
                          >
                            Làm mới Token
                          </button>
                          {action !== undefined && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busyId === account.id}
                              onClick={() => runAction(account.id, () => api.setAccountStatus(account.id, action.next))}
                            >
                              {action.label}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busyId === account.id}
                            onClick={() => handleDelete(account)}
                          >
                            Xóa
                          </button>
                        </div>
                        {rowError?.id === account.id && (
                          <div style={{ marginTop: 8, maxWidth: 320 }}>
                            <ErrorBanner error={rowError.error} />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AsyncSection>
    </Layout>
  );
}
