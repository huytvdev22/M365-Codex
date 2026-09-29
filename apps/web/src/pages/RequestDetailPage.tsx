import { useParams } from 'react-router';
import { api } from '../api';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { ResponseStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

export function RequestDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useAsync(() => api.getRequest(id), [id]);

  return (
    <Layout title="Chi tiết yêu cầu" subtitle={id}>
      <AsyncSection loading={loading} error={error} data={data} onRetry={reload}>
        {(detail) => (
          <>
            <div className="card">
              <div className="grid grid-cols-3">
                <div>
                  <div className="stat-label">Trạng thái</div>
                  <ResponseStatusBadge status={detail.status} />
                </div>
                <div>
                  <div className="stat-label">Mô hình</div>
                  <div>{detail.requested_model}</div>
                </div>
                <div>
                  <div className="stat-label">Reasoning Effort</div>
                  <div>{detail.requested_reasoning_effort ?? '—'}</div>
                </div>
                <div>
                  <div className="stat-label">API Key</div>
                  <div className="mono">{detail.api_key_id ?? '—'}</div>
                </div>
                <div>
                  <div className="stat-label">Tài khoản</div>
                  <div className="mono">{detail.account_id ?? '—'}</div>
                </div>
                <div>
                  <div className="stat-label">Lượt công cụ / Tổng lần gọi</div>
                  <div>
                    {detail.tool_round} / {detail.tool_calls_total}
                  </div>
                </div>
                <div>
                  <div className="stat-label">Thời gian tạo</div>
                  <div>{formatDateTime(detail.created_at)}</div>
                </div>
                <div>
                  <div className="stat-label">Thời gian cập nhật</div>
                  <div>{formatDateTime(detail.updated_at)}</div>
                </div>
              </div>
              {detail.error_message !== null && (
                <div className="error-banner" style={{ marginTop: 16 }}>
                  <div className="error-title">Thông tin lỗi</div>
                  <div>{detail.error_message}</div>
                </div>
              )}
            </div>

            <div className="card">
              <h2 style={{ marginTop: 0 }}>Các cuộc gọi công cụ (không chứa tham số và kết quả)</h2>
              {detail.tool_calls.length === 0 ? (
                <div className="text-muted">Yêu cầu này không kích hoạt gọi công cụ nào.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Mã Call ID</th>
                        <th>Tên công cụ</th>
                        <th>Trạng thái</th>
                        <th>Tác dụng phụ (Side effect)</th>
                        <th>Thời gian</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.tool_calls.map((call) => (
                        <tr key={call.call_id}>
                          <td className="mono">{call.call_id}</td>
                          <td>{call.name}</td>
                          <td>{call.status}</td>
                          <td>{call.side_effect ? 'Có' : 'Không'}</td>
                          <td>{formatDateTime(call.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}
