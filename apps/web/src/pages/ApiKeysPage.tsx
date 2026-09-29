import { useState, type FormEvent } from 'react';
import { api, type ApiKeyView, type CreateApiKeyRequest } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { RevealApiKeyModal } from '../components/RevealApiKeyModal';
import { AsyncSection } from '../components/StateBlock';
import { BoolBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

function CreateApiKeyForm({ onCreated }: { onCreated: (key: string) => void }) {
  const [name, setName] = useState('');
  const [rpmLimit, setRpmLimit] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const toPositiveIntOrNull = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload: CreateApiKeyRequest = {
      name: name.trim(),
      rpm_limit: toPositiveIntOrNull(rpmLimit),
      daily_limit: toPositiveIntOrNull(dailyLimit),
      max_concurrency: toPositiveIntOrNull(maxConcurrency),
    };
    api
      .createApiKey(payload)
      .then((created) => {
        onCreated(created.key);
        setName('');
        setRpmLimit('');
        setDailyLimit('');
        setMaxConcurrency('');
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2 style={{ marginTop: 0 }}>Tạo API Key mới</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="key-name">Tên gợi nhớ</label>
          <input id="key-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="key-rpm">Giới hạn RPM (mỗi phút)</label>
          <input id="key-rpm" type="number" min={1} value={rpmLimit} onChange={(e) => setRpmLimit(e.target.value)} placeholder="Không giới hạn" />
        </div>
        <div className="field">
          <label htmlFor="key-daily">Hạn mức mỗi ngày</label>
          <input id="key-daily" type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder="Không giới hạn" />
        </div>
        <div className="field">
          <label htmlFor="key-concurrency">Đồng thời tối đa</label>
          <input
            id="key-concurrency"
            type="number"
            min={1}
            value={maxConcurrency}
            onChange={(e) => setMaxConcurrency(e.target.value)}
            placeholder="Không giới hạn"
          />
        </div>
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="submit" className="btn btn-primary" disabled={submitting || name.trim().length === 0}>
        {submitting ? 'Đang tạo…' : 'Tạo mới'}
      </button>
    </form>
  );
}

export function ApiKeysPage() {
  const { data, error, loading, reload } = useAsync(() => api.listApiKeys());
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

  const toggleEnabled = (key: ApiKeyView) => {
    setBusyId(key.id);
    setRowError(null);
    api
      .updateApiKey(key.id, { enabled: !key.enabled })
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: key.id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleRevoke = (key: ApiKeyView) => {
    if (!window.confirm(`Xác nhận thu hồi "${key.name}"? Sau khi thu hồi sẽ không thể khôi phục.`)) return;
    setBusyId(key.id);
    setRowError(null);
    api
      .revokeApiKey(key.id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: key.id, error: err }))
      .finally(() => setBusyId(null));
  };

  return (
    <Layout title="API Key" subtitle="Tạo, phân bổ hạn mức và thu hồi khóa API đối ngoại">
      <CreateApiKeyForm
        onCreated={(key) => {
          setRevealKey(key);
          reload();
        }}
      />

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(list) => list.length === 0}
        emptyTitle="Chưa có API Key nào được tạo"
      >
        {(keys) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tên</th>
                  <th>Khóa bí mật</th>
                  <th>Trạng thái</th>
                  <th>Hạn mức</th>
                  <th>Dùng gần nhất</th>
                  <th>Thời gian tạo</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="mono">{key.masked_key}</td>
                    <td>
                      <BoolBadge value={key.enabled} trueLabel="Đang bật" falseLabel={key.revoked_at !== null ? 'Đã thu hồi' : 'Đã tắt'} />
                    </td>
                    <td className="text-muted">
                      {key.rpm_limit !== null ? `${key.rpm_limit}/phút · ` : ''}
                      {key.daily_limit !== null ? `${key.daily_limit}/ngày · ` : ''}
                      {key.max_concurrency !== null ? `Đồng thời ${key.max_concurrency}` : ''}
                      {key.rpm_limit === null && key.daily_limit === null && key.max_concurrency === null && 'Không giới hạn'}
                    </td>
                    <td>{formatDateTime(key.last_used_at)}</td>
                    <td>{formatDateTime(key.created_at)}</td>
                    <td>
                      <div className="flex gap-8">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busyId === key.id || key.revoked_at !== null}
                          onClick={() => toggleEnabled(key)}
                        >
                          {key.enabled ? 'Tắt' : 'Bật'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busyId === key.id || key.revoked_at !== null}
                          onClick={() => handleRevoke(key)}
                        >
                          Thu hồi
                        </button>
                      </div>
                      {rowError?.id === key.id && (
                        <div style={{ marginTop: 8, maxWidth: 320 }}>
                          <ErrorBanner error={rowError.error} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncSection>

      {revealKey !== null && <RevealApiKeyModal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </Layout>
  );
}
