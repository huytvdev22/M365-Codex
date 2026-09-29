import { api } from '../api';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { CapabilityStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';

export function CapabilitiesPage() {
  const { data, error, loading, reload } = useAsync(() => api.getCapabilities());

  return (
    <Layout title="Mô hình & Năng lực" subtitle="model và reasoning.effort được chuyển tiếp nguyên trạng, trang này chỉ ghi nhận và báo cáo trung thực">
      <AsyncSection loading={loading} error={error} data={data} onRetry={reload}>
        {(caps) => (
          <>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Các mô hình đã ghi nhận</h2>
              <p className="text-muted">
                Dự án không tự tạo bí danh model mới — danh sách này liệt kê các giá trị <code>model</code> đã từng được client yêu cầu và được ghi nhận lại,
                không có sự can thiệp sửa đổi nào.
              </p>
              <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                {caps.models.map((m) => (
                  <span key={m.id} className="badge badge-info mono">
                    {m.id} ({m.source})
                  </span>
                ))}
                {caps.models.length === 0 && <span className="text-faint">Chưa ghi nhận yêu cầu nào</span>}
              </div>
            </div>

            <div className="card table-wrap">
              <h2 style={{ marginTop: 0 }}>Ma trận năng lực</h2>
              <p className="text-muted">
                Các năng lực chưa qua kiểm chứng bởi M0 Probe sẽ được đánh dấu <code>upstream_decided</code> hoặc <code>unsupported</code>,
                không tự ý đánh dấu là <code>native</code>.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Năng lực / Tính năng</th>
                    <th>Trạng thái</th>
                    <th>Mô tả chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {caps.matrix.map((row) => (
                    <tr key={row.feature}>
                      <td className="mono">{row.feature}</td>
                      <td>
                        <CapabilityStatusBadge status={row.status} />
                      </td>
                      <td className="text-muted">{row.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}
