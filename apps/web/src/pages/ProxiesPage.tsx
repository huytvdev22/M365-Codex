import { useState, type FormEvent } from 'react';
import { api, type BulkImportProxyResult, type ProxyView } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { ProxyStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

/**
 * Pool Proxy Egress. Địa chỉ luôn hiển thị ở dạng che thông tin nhạy cảm (`url_masked`, user/pass không bao giờ ở dạng rõ trong DOM) —
 * người dùng nhập URL đầy đủ một lần gửi cho server, sau khi lưu xong trang chỉ render kết quả đã được che thông tin do server trả về.
 */
function CreateProxyForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [weight, setWeight] = useState(10);
  const [priority, setPriority] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    api
      .createProxy({ name: name.trim(), url: url.trim(), weight, priority, enabled: true })
      .then(() => {
        setName('');
        setUrl('');
        onCreated();
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2 style={{ marginTop: 0 }}>Thêm nút Proxy mới</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="proxy-name">Tên gợi nhớ</label>
          <input id="proxy-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field" style={{ flex: '2 1 320px' }}>
          <label htmlFor="proxy-url">Địa chỉ Proxy</label>
          <input
            id="proxy-url"
            type="text"
            placeholder="socks5://user:pass@1.2.3.4:1080"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            required
          />
          <span className="field-hint">Sau khi gửi sẽ che mặt nạ hiển thị ngay, thông tin bản rõ không lưu lại trên trang.</span>
        </div>
        <div className="field">
          <label htmlFor="proxy-weight">Trọng số (Weight)</label>
          <input id="proxy-weight" type="number" min={1} value={weight} onChange={(e) => setWeight(Number(e.target.value) || 1)} />
        </div>
        <div className="field">
          <label htmlFor="proxy-priority">Độ ưu tiên</label>
          <input id="proxy-priority" type="number" min={1} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 1)} />
        </div>
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="submit" className="btn btn-primary" disabled={submitting || name.trim().length === 0 || url.trim().length === 0}>
        {submitting ? 'Đang tạo…' : 'Tạo mới'}
      </button>
    </form>
  );
}

function BulkImportForm({ onImported }: { onImported: () => void }) {
  const [urls, setUrls] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<BulkImportProxyResult | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    api
      .bulkImportProxies({ urls })
      .then((res) => {
        setResult(res);
        setUrls('');
        onImported();
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h2 style={{ marginTop: 0 }}>Nhập hàng loạt nhiều dòng</h2>
      <div className="field">
        <label htmlFor="proxy-bulk">Mỗi dòng một địa chỉ URL</label>
        <textarea
          id="proxy-bulk"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder={'http://user:pass@1.2.3.4:8080\nsocks5://user:pass@5.6.7.8:1080'}
        />
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      {result !== null && (
        <div style={{ marginBottom: 12 }}>
          <div className="text-muted">
            Thành công {result.created} mục, thất bại {result.failed} mục
          </div>
          {result.results.some((r) => !r.ok) && (
            <ul style={{ marginTop: 6 }}>
              {result.results
                .filter((r) => !r.ok)
                .map((r, i) => (
                  <li key={`${r.line}-${i}`} className="text-faint">
                    {r.line || '(Dòng trống)'}：{r.error ?? 'Lỗi không xác định'}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      <button type="submit" className="btn" disabled={submitting || urls.trim().length === 0}>
        {submitting ? 'Đang nhập…' : 'Nhập hàng loạt'}
      </button>
    </form>
  );
}

export function ProxiesPage() {
  const { data, error, loading, reload } = useAsync(() => api.listProxies());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<{ id: string; ok: boolean; latency_ms: number | null; detail: string } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);

  const handleCheck = (proxy: ProxyView) => {
    setBusyId(proxy.id);
    setRowError(null);
    setCheckResult(null);
    api
      .checkProxy(proxy.id)
      .then((res) => {
        setCheckResult({ id: proxy.id, ...res });
        reload();
      })
      .catch((err: unknown) => setRowError({ id: proxy.id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleToggle = (proxy: ProxyView) => {
    setBusyId(proxy.id);
    setRowError(null);
    api
      .updateProxy(proxy.id, { enabled: !proxy.enabled })
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: proxy.id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleDelete = (proxy: ProxyView) => {
    if (!window.confirm(`Xác nhận xóa nút proxy "${proxy.name}"?`)) return;
    setBusyId(proxy.id);
    setRowError(null);
    api
      .deleteProxy(proxy.id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id: proxy.id, error: err }))
      .finally(() => setBusyId(null));
  };

  return (
    <Layout title="Nhóm Proxy" subtitle="Quản lý các nút proxy lối ra, địa chỉ luôn được che mặt nạ an toàn">
      <div className="grid grid-cols-2">
        <CreateProxyForm onCreated={reload} />
        <BulkImportForm onImported={reload} />
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(list) => list.length === 0}
        emptyTitle="Chưa cấu hình nút proxy nào"
      >
        {(proxies) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tên</th>
                  <th>Địa chỉ (Đã che mặt nạ)</th>
                  <th>Trạng thái</th>
                  <th>Trọng số / Ưu tiên</th>
                  <th>Độ trễ</th>
                  <th>Tài khoản liên kết</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((proxy) => (
                  <tr key={proxy.id}>
                    <td>{proxy.name}</td>
                    <td className="mono">{proxy.url_masked}</td>
                    <td>
                      <ProxyStatusBadge status={proxy.enabled ? proxy.status : 'unknown'} />
                      {!proxy.enabled && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>Đã tắt</span>}
                    </td>
                    <td>
                      {proxy.weight} / {proxy.priority}
                    </td>
                    <td>{proxy.latency_ms !== null ? `${proxy.latency_ms} ms` : '—'}</td>
                    <td className="text-faint">{proxy.bound_accounts.length > 0 ? proxy.bound_accounts.join(', ') : 'Chưa liên kết'}</td>
                    <td>
                      <div className="flex gap-8">
                        <button type="button" className="btn btn-sm" disabled={busyId === proxy.id} onClick={() => handleCheck(proxy)}>
                          Kiểm tra kết nối
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busyId === proxy.id} onClick={() => handleToggle(proxy)}>
                          {proxy.enabled ? 'Tắt' : 'Bật'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busyId === proxy.id}
                          onClick={() => handleDelete(proxy)}
                        >
                          Xóa
                        </button>
                      </div>
                      {checkResult?.id === proxy.id && (
                        <div className="text-muted" style={{ marginTop: 6 }}>
                          {checkResult.ok ? 'Kết nối tốt' : 'Kết nối thất bại'}
                          {checkResult.latency_ms !== null ? ` · ${checkResult.latency_ms} ms` : ''} · {checkResult.detail}
                        </div>
                      )}
                      {rowError?.id === proxy.id && (
                        <div style={{ marginTop: 8, maxWidth: 280 }}>
                          <ErrorBanner error={rowError.error} />
                        </div>
                      )}
                      {proxy.last_check_at !== null && (
                        <div className="text-faint" style={{ marginTop: 4 }}>
                          Kiểm tra lần cuối lúc {formatDateTime(proxy.last_check_at)}
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
    </Layout>
  );
}
