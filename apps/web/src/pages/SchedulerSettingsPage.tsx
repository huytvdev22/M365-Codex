import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function SchedulerSettingsPage() {
  return (
    <SettingsGroupPage
      title="Lập lịch điều phối"
      subtitle="Chu kỳ tác vụ dọn dẹp nền và thời gian lưu trữ dữ liệu (tương ứng nhóm scheduler trong /admin/settings, đơn vị ms)"
      groups={[
        {
          group: 'scheduler',
          heading: 'Chính sách Dọn dẹp & Lưu trữ',
          fields: [
            {
              key: 'cleanup_interval_ms',
              label: 'Khoảng cách giữa các lần chạy dọn dẹp',
              kind: 'number',
              unit: 'ms',
              hint: 'Khoảng thời gian giữa hai lần tác vụ dọn dẹp nền thực thi.',
            },
            {
              key: 'response_retention_ms',
              label: 'Thời gian lưu trữ bản ghi Response',
              kind: 'number',
              unit: 'ms',
              hint: 'Các yêu cầu/phản hồi lịch sử quá thời gian này sẽ bị tác vụ dọn dẹp xóa bỏ.',
            },
            {
              key: 'audit_log_retention_ms',
              label: 'Thời gian lưu trữ nhật ký kiểm toán (Audit log)',
              kind: 'number',
              unit: 'ms',
            },
            {
              key: 'idempotency_retention_ms',
              label: 'Thời gian lưu giữ khóa Idempotency',
              kind: 'number',
              unit: 'ms',
              hint: 'Thời gian lưu khóa chống trùng lặp, sau khi hết hạn cho phép dùng lại cùng một key.',
            },
            {
              key: 'files_retention_ms',
              label: 'Thời gian lưu trữ tệp tải lên',
              kind: 'number',
              unit: 'ms',
              hint: 'Vượt quá thời gian này tệp tải lên sẽ bị xóa định kỳ.',
            },
            {
              key: 'files_upload_ttl_ms',
              label: 'Thời hạn sống của phiên tải tệp (Upload TTL)',
              kind: 'number',
              unit: 'ms',
              hint: 'Thời hạn cho phép hoàn tất phiên upload tệp, quá hạn sẽ bị dọn dẹp.',
            },
          ],
        },
      ]}
    />
  );
}
