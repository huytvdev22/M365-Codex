import { useState } from 'react';
import { api, type FilesCleanupResult } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { useAsync } from '../hooks/useAsync';
import { formatBytes, formatDateTime } from '../util/format';

export function FilesPage() {
  const { data, error, loading, reload } = useAsync(() => api.listFiles({}));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<FilesCleanupResult | null>(null);
  const [cleanupError, setCleanupError] = useState<unknown>(null);

  const handleDelete = (id: string, filename: string) => {
    if (!window.confirm(`Xác nhận xóa tệp "${filename}"?`)) return;
    setBusyId(id);
    setRowError(null);
    api
      .deleteFile(id)
      .then(() => reload())
      .catch((err: unknown) => setRowError({ id, error: err }))
      .finally(() => setBusyId(null));
  };

  const handleCleanup = () => {
    setCleaning(true);
    setCleanupError(null);
    api
      .cleanupFiles()
      .then((res) => {
        setCleanupResult(res);
        reload();
      })
      .catch((err: unknown) => setCleanupError(err))
      .finally(() => setCleaning(false));
  };

  return (
    <Layout title="Quản lý tệp" subtitle="Quản lý tệp đã tải lên (Files / Uploads / Ảnh / PDF / Văn bản trích xuất Office)">
      <div className="card flex-between">
        <div>
          <div className="stat-label">Dọn dẹp các tệp hết hạn ngay lập tức</div>
          {cleanupResult !== null && (
            <div className="text-muted">
              Đợt trước đã xóa {cleanupResult.deleted_files} tệp, {cleanupResult.deleted_uploads} lượt tải dang dở,
              giải phóng {formatBytes(cleanupResult.freed_bytes)}
            </div>
          )}
          {cleanupError !== null && <ErrorBanner error={cleanupError} />}
        </div>
        <button type="button" className="btn" onClick={handleCleanup} disabled={cleaning}>
          {cleaning ? 'Đang dọn dẹp…' : 'Dọn dẹp ngay'}
        </button>
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(res) => res.items.length === 0}
        emptyTitle="Chưa có tệp tin nào"
      >
        {(res) => (
          <div className="card table-wrap">
            <div className="text-muted" style={{ marginBottom: 10 }}>
              Tổng cộng {res.items.length} tệp, tổng dung lượng {formatBytes(res.total_bytes)}
            </div>
            <table>
              <thead>
                <tr>
                  <th>Tên tệp</th>
                  <th>Loại tệp</th>
                  <th>Kích thước</th>
                  <th>Trạng thái</th>
                  <th>API Key sở hữu</th>
                  <th>Thời gian tạo</th>
                  <th>Thời gian hết hạn</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {res.items.map((file) => (
                  <tr key={file.id}>
                    <td>{file.filename}</td>
                    <td className="text-muted">
                      {file.kind} · {file.mime_type}
                    </td>
                    <td>{formatBytes(file.bytes)}</td>
                    <td>{file.status}</td>
                    <td className="mono text-faint">{file.api_key_id ?? '—'}</td>
                    <td>{formatDateTime(file.created_at)}</td>
                    <td>{formatDateTime(file.expires_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busyId === file.id}
                        onClick={() => handleDelete(file.id, file.filename)}
                      >
                        Xóa
                      </button>
                      {rowError?.id === file.id && (
                        <div style={{ marginTop: 8, maxWidth: 280 }}>
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
    </Layout>
  );
}
