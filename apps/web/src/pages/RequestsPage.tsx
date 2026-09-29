import { useState } from 'react';
import { Link } from 'react-router';
import { api, type ResponseStatus } from '../api';
import { Layout } from '../components/Layout';
import { AsyncSection } from '../components/StateBlock';
import { ResponseStatusBadge } from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../util/format';

const STATUS_OPTIONS: Array<{ value: ResponseStatus | ''; label: string }> = [
  { value: '', label: 'Tất cả trạng thái' },
  { value: 'queued', label: 'Đang xếp hàng' },
  { value: 'in_progress', label: 'Đang xử lý' },
  { value: 'completed', label: 'Đã hoàn tất' },
  { value: 'incomplete', label: 'Chưa hoàn tất' },
  { value: 'failed', label: 'Thất bại' },
  { value: 'cancelled', label: 'Đã hủy' },
];

/** Không chứa prompt và nội dung văn bản đầu ra — trong chế độ riêng tư strict phía server không lưu trữ, tại đây chỉ hiển thị metadata. */
export function RequestsPage() {
  const [status, setStatus] = useState<ResponseStatus | ''>('');
  const [limit, setLimit] = useState(50);
  const { data, error, loading, reload } = useAsync(
    () => api.listRequests({ limit, status: status || undefined }),
    [status, limit],
  );

  return (
    <Layout title="Nhật ký yêu cầu" subtitle="Lịch sử các yêu cầu (không chứa prompt và văn bản phản hồi)">
      <div className="card">
        <div className="form-row">
          <div className="field">
            <label htmlFor="req-status">Lọc theo trạng thái</label>
            <select id="req-status" value={status} onChange={(e) => setStatus(e.target.value as ResponseStatus | '')}>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="req-limit">Số dòng hiển thị</label>
            <input
              id="req-limit"
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 50)}
            />
          </div>
        </div>
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(res) => res.items.length === 0}
        emptyTitle="Không có yêu cầu phù hợp"
      >
        {(res) => (
          <div className="card table-wrap">
            <div className="text-muted" style={{ marginBottom: 10 }}>
              Tổng cộng {res.total} mục, hiện đang hiển thị {res.items.length} mục
            </div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Trạng thái</th>
                  <th>Mô hình</th>
                  <th>Reasoning Effort</th>
                  <th>Tài khoản</th>
                  <th>Lượt công cụ / Tổng lần gọi</th>
                  <th>Thời gian tạo</th>
                  <th>Lỗi</th>
                </tr>
              </thead>
              <tbody>
                {res.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link to={`/requests/${item.id}`} className="mono">
                        {item.id}
                      </Link>
                    </td>
                    <td>
                      <ResponseStatusBadge status={item.status} />
                    </td>
                    <td>{item.requested_model}</td>
                    <td>{item.requested_reasoning_effort ?? '—'}</td>
                    <td className="mono text-faint">{item.account_id ?? '—'}</td>
                    <td>
                      {item.tool_round} / {item.tool_calls_total}
                    </td>
                    <td>{formatDateTime(item.created_at)}</td>
                    <td className="text-danger">{item.error_message ?? ''}</td>
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
