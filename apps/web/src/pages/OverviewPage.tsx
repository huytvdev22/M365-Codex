import { api } from '../api';
import { CopyButton } from '../components/CopyButton';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { SystemStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatBytes, formatDuration, formatPercent } from '../util/format';

export function OverviewPage() {
  const { data, error, loading, reload } = useAsync(() => api.getOverview());

  return (
    <Layout title="Tổng quan" subtitle="Tổng quan trạng thái dịch vụ, dữ liệu từ /admin/overview">
      <AsyncSection loading={loading} error={error} data={data} onRetry={reload}>
        {(overview) => (
          <>
            <div className="card">
              <div className="flex-between">
                <div className="flex gap-12" style={{ alignItems: 'center' }}>
                  <SystemStatusBadge status={overview.system_status} />
                  <span className="text-muted">Phiên bản {overview.version}</span>
                  <span className="text-muted">Đã chạy {formatDuration(overview.uptime_ms)}</span>
                </div>
                <button type="button" className="btn btn-sm" onClick={reload}>
                  Làm mới
                </button>
              </div>
            </div>

            <div className="grid grid-cols-4" style={{ marginTop: 16 }}>
              <div className="card stat-tile">
                <span className="stat-label">Tài khoản online / Tổng số</span>
                <span className="stat-value">
                  {overview.accounts.online} / {overview.accounts.total}
                </span>
                <span className="stat-hint">
                  Làm nguội {overview.accounts.cooldown} · Cần ủy quyền lại {overview.accounts.reauth_required} · Đã tắt{' '}
                  {overview.accounts.disabled}
                </span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">Yêu cầu hiện tại</span>
                <span className="stat-value">{overview.requests.in_flight}</span>
                <span className="stat-hint">
                  1 giờ qua: {overview.requests.last_hour} lượt, thất bại {overview.requests.failed_last_hour} lượt
                </span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">Tỷ lệ gọi công cụ thành công</span>
                <span className="stat-value">{formatPercent(overview.tools.arg_pass_rate)}</span>
                <span className="stat-hint">1 giờ qua đã gọi {overview.tools.calls_last_hour} lần</span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">Phiên bản giao thức upstream</span>
                <span className="stat-value" style={{ fontSize: 16 }}>
                  {overview.upstream.protocol_version}
                </span>
                <span className="stat-hint">
                  {overview.upstream.ws_base} · Nhập ảnh {overview.upstream.image_input ? 'Đã bật' : 'Chưa bật'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3" style={{ marginTop: 16 }}>
              <div className="card stat-tile">
                <span className="stat-label">Dung lượng CSDL</span>
                <span className="stat-value" style={{ fontSize: 18 }}>
                  {formatBytes(overview.storage.db_bytes)}
                </span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">Dung lượng tệp lưu trữ</span>
                <span className="stat-value" style={{ fontSize: 18 }}>
                  {formatBytes(overview.storage.files_bytes)}
                </span>
                <span className="stat-hint">Tổng cộng {overview.storage.files_count} tệp</span>
              </div>
              <div className="card stat-tile">
                <span className="stat-label">Trạng thái Token</span>
                <span className="stat-value" style={{ fontSize: 18 }}>
                  {overview.accounts.reauth_required > 0 ? 'Cần xử lý' : 'Bình thường'}
                </span>
                <span className="stat-hint">
                  {overview.accounts.reauth_required > 0
                    ? `${overview.accounts.reauth_required} tài khoản cần ủy quyền lại`
                    : 'Tất cả token tài khoản đều hợp lệ'}
                </span>
              </div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="flex-between">
                <div>
                  <div className="stat-label">Địa chỉ API công khai hiện tại</div>
                  <div className="mono" style={{ marginTop: 6 }}>
                    {overview.public_api_base_url}
                  </div>
                </div>
                <CopyButton value={overview.public_api_base_url} />
              </div>
            </div>

            {overview.pending_restart.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="stat-label" style={{ marginBottom: 8 }}>
                  Các mục cấu hình cần khởi động lại để có hiệu lực
                </div>
                <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                  {overview.pending_restart.map((key) => (
                    <span key={key} className="badge badge-warn">
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}
