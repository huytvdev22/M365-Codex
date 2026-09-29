import { useState, type ChangeEvent, type FormEvent } from 'react';
import { api, type BackupInfo, type DiagnosticsReport, type RestoreResult } from '../api';
import { CopyButton } from '../components/CopyButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { useAsync } from '../hooks/useAsync';
import { formatBytes, formatDateTime } from '../util/format';

/**
 * Sao lưu / Phục hồi / Chẩn đoán, tương ứng phía server apps/server/src/routes/backup.ts:
 *   POST /admin/backup, GET /admin/backup, GET /admin/backup/:id/download,
 *   POST /admin/restore, GET /admin/diagnostics.
 *
 * Ngữ nghĩa phục hồi cần truyền đạt chính xác: server chỉ thực hiện "Kiểm tra + Ghi đĩa", tiến trình đang chạy vẫn giữ kết nối CSDL cũ,
 * giao diện không được ngầm hiểu phục hồi xong là có hiệu lực ngay — sau khi tải lên thành công bắt buộc phải khởi động lại server.
 */

/** Kích hoạt trình duyệt tải xuống một Blob trong bộ nhớ; giải phóng object URL ngay sau khi dùng. */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function CreateBackupCard({ onCreated }: { onCreated: (info: BackupInfo) => void }) {
  const [includeFiles, setIncludeFiles] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleCreate = () => {
    setCreating(true);
    setError(null);
    api
      .createBackup({ includeFiles })
      .then((info) => onCreated(info))
      .catch((err: unknown) => setError(err))
      .finally(() => setCreating(false));
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Tạo bản sao lưu</h2>
      <div className="field">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={includeFiles}
            onChange={(e) => setIncludeFiles(e.target.checked)}
          />
          Bao gồm các tệp đã tải lên
        </label>
        <span className="field-hint">
          Bản sao lưu luôn bao gồm snapshot CSDL nhất quán (tạo bằng VACUUM INTO); tích chọn mục này sẽ đóng gói thêm
          toàn bộ tệp trong thư mục <code>files/</code>. Khóa chủ không nằm trong bản sao lưu — khi phục hồi sang máy khác
          vẫn cần cung cấp cùng một <code>M365_CODEX_MASTER_KEY</code>.
        </span>
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
        {creating ? 'Đang tạo…' : 'Tạo bản sao lưu'}
      </button>
    </div>
  );
}

function BackupListCard({ refreshKey }: { refreshKey: number }) {
  const { data, error, loading, reload } = useAsync(() => api.listBackups(), [refreshKey]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ id: string; error: unknown } | null>(null);

  const handleDownload = (backup: BackupInfo) => {
    setDownloadingId(backup.id);
    setDownloadError(null);
    api
      .downloadBackup(backup.id)
      .then((blob) => triggerBlobDownload(blob, `${backup.id}.tar.gz`))
      .catch((err: unknown) => setDownloadError({ id: backup.id, error: err }))
      .finally(() => setDownloadingId(null));
  };

  return (
    <div className="card table-wrap">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Danh sách bản sao lưu</h2>
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
        emptyTitle="Chưa có bản sao lưu nào được tạo"
      >
        {(backups) => (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Kích thước</th>
                <th>Thời gian tạo</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.id}>
                  <td className="mono">{backup.id}</td>
                  <td>{formatBytes(backup.bytes)}</td>
                  <td>{formatDateTime(backup.created_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={downloadingId === backup.id}
                      onClick={() => handleDownload(backup)}
                    >
                      {downloadingId === backup.id ? 'Đang tải…' : 'Tải về'}
                    </button>
                    {downloadError?.id === backup.id && (
                      <div style={{ marginTop: 8, maxWidth: 280 }}>
                        <ErrorBanner error={downloadError.error} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncSection>
    </div>
  );
}

function RestoreCard() {
  const [file, setFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    setResult(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (file === null) return;
    if (
      !window.confirm(
        'Sắp tải lên gói sao lưu và ghi đè cơ sở dữ liệu hiện tại (thư mục tệp tùy thuộc nội dung sao lưu).\n\n' +
          'Xác minh thành công chỉ đại diện cho việc dữ liệu đã ghi xuống đĩa, tuyệt đối KHÔNG có nghĩa là dịch vụ đang chạy đã chuyển sang dữ liệu mới —\n' +
          'Bắt buộc phải khởi động lại dịch vụ sau khi phục hồi, trước khi khởi động lại dịch vụ vẫn chạy trên dữ liệu cũ. Xác nhận tiếp tục?',
      )
    ) {
      return;
    }
    setRestoring(true);
    setError(null);
    setResult(null);
    api
      .restoreBackup(file)
      .then((res) => setResult(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setRestoring(false));
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Phục hồi từ bản sao lưu</h2>
      <div className="error-banner" style={{ marginBottom: 12 }}>
        <div className="error-title">Phục hồi sẽ không có hiệu lực ngay lập tức</div>
        <div>
          Gói sao lưu tải lên sẽ được kiểm tra định dạng và phiên bản schema trước khi ghi vào thư mục dữ liệu; tuy nhiên tiến trình server đang chạy vẫn giữ kết nối đến CSDL cũ,
          <strong> bắt buộc phải khởi động lại server thủ công thì dữ liệu phục hồi mới thực sự có hiệu lực</strong>. Trước khi khởi động lại, dịch vụ vẫn hoạt động trên dữ liệu cũ.
        </div>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="restore-file">Tệp gói sao lưu (.tar.gz)</label>
          <input id="restore-file" type="file" accept=".gz,.tar.gz" onChange={handleFileChange} />
        </div>
        {error !== null && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBanner error={error} />
          </div>
        )}
        <button type="submit" className="btn btn-danger" disabled={restoring || file === null}>
          {restoring ? 'Đang tải lên và kiểm tra…' : 'Tải lên & Phục hồi'}
        </button>
      </form>
      {result !== null && (
        <div className="error-banner" style={{ marginTop: 14 }}>
          <div className="error-title">
            <span className="badge badge-warn" style={{ marginRight: 8 }}>
              Cần khởi động lại để áp dụng
            </span>
            Đã ghi bản sao lưu vào thư mục dữ liệu
          </div>
          <div>{result.message}</div>
          <div className="text-muted" style={{ marginTop: 8 }}>
            Bản sao lưu tạo lúc {formatDateTime(result.manifest.created_at)} · schema v{result.manifest.schema_version} ·
            {result.manifest.includes_files
              ? ` Bao gồm ${result.manifest.file_count} tệp`
              : ' Không bao gồm tệp đã tải lên'}
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticsCard() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleGenerate = () => {
    setLoading(true);
    setError(null);
    api
      .getDiagnostics()
      .then((res) => setReport(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  };

  const handleDownloadJson = () => {
    if (report === null) return;
    triggerBlobDownload(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
      `diagnostics-${report.generated_at}.json`,
    );
  };

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Gói chẩn đoán (Diagnostics)</h2>
        <div className="flex gap-8">
          {report !== null && (
            <button type="button" className="btn btn-sm" onClick={handleDownloadJson}>
              Tải JSON
            </button>
          )}
          <button type="button" className="btn btn-sm btn-primary" onClick={handleGenerate} disabled={loading}>
            {loading ? 'Đang tạo…' : 'Tạo gói chẩn đoán'}
          </button>
        </div>
      </div>
      <div className="field-hint" style={{ marginBottom: 12 }}>
        Chỉ tổng hợp số liệu thống kê và cấu hình tóm tắt đã được khử dữ liệu nhạy cảm, không chứa prompt, văn bản đầu ra, email, Token hay tên file; an toàn để đính kèm khi báo cáo lỗi.
      </div>
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      {report !== null && (
        <div className="grid grid-cols-2">
          <div>
            <div className="stat-label">Trạng thái hệ thống</div>
            <div>{report.system_status}</div>
          </div>
          <div>
            <div className="stat-label">Thời gian chạy</div>
            <div>{Math.round(report.uptime_ms / 60_000)} phút</div>
          </div>
          <div>
            <div className="stat-label">Phiên bản cấu trúc CSDL</div>
            <div>
              v{report.schema.current} (kỳ vọng v{report.schema.expected}){report.schema.ok ? '' : ' · Không khớp'}
            </div>
          </div>
          <div>
            <div className="stat-label">Dung lượng lưu trữ</div>
            <div>
              CSDL {formatBytes(report.storage.db_bytes)} · Tệp {formatBytes(report.storage.files_bytes)} (
              {report.storage.file_count} tệp)
            </div>
          </div>
          <div>
            <div className="stat-label">Tài khoản khả dụng</div>
            <div>{report.accounts_usable}</div>
          </div>
          <div>
            <div className="stat-label">Yêu cầu đang xử lý</div>
            <div>{report.in_flight_requests}</div>
          </div>
          {report.notes.length > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="stat-label">Ghi chú</div>
              <ul>
                {report.notes.map((note) => (
                  <li key={note} className="text-muted">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BackupPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastCreated, setLastCreated] = useState<BackupInfo | null>(null);

  const handleCreated = (info: BackupInfo) => {
    setLastCreated(info);
    setRefreshKey((k) => k + 1);
  };

  return (
    <Layout title="Sao lưu & Phục hồi" subtitle="Sao lưu, phục hồi cơ sở dữ liệu & tệp tin, xuất gói chẩn đoán hệ thống">
      <div className="grid grid-cols-2">
        <CreateBackupCard onCreated={handleCreated} />
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Lần tạo gần nhất</h2>
          {lastCreated === null ? (
            <div className="text-muted">Chưa tạo bản sao lưu nào trong phiên làm việc này.</div>
          ) : (
            <div>
              <div className="flex gap-8" style={{ alignItems: 'center' }}>
                <span className="mono">{lastCreated.id}</span>
                <CopyButton value={lastCreated.id} label="Sao chép ID" />
              </div>
              <div className="text-muted" style={{ marginTop: 6 }}>
                {formatBytes(lastCreated.bytes)} · {formatDateTime(lastCreated.created_at)}
              </div>
            </div>
          )}
        </div>
      </div>

      <BackupListCard refreshKey={refreshKey} />
      <RestoreCard />
      <DiagnosticsCard />
    </Layout>
  );
}
