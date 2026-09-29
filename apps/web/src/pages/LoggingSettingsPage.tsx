import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function LoggingSettingsPage() {
  return (
    <SettingsGroupPage
      title="Nhật ký log"
      subtitle="Cấp độ log và chế độ riêng tư (tương ứng nhóm logging trong /admin/settings)"
      groups={[
        {
          group: 'logging',
          heading: 'Cấu hình Log',
          fields: [
            {
              key: 'log_level',
              label: 'Cấp độ log (Log Level)',
              kind: 'select',
              options: [
                { value: 'fatal', label: 'fatal' },
                { value: 'error', label: 'error' },
                { value: 'warn', label: 'warn' },
                { value: 'info', label: 'info (Mặc định)' },
                { value: 'debug', label: 'debug' },
                { value: 'trace', label: 'trace' },
                { value: 'silent', label: 'silent (Không xuất log)' },
              ],
              hint: 'Đây là mục cấu hình duy nhất có hiệu lực ngay lập tức mà không cần khởi động lại dịch vụ.',
            },
            {
              key: 'log_privacy_mode',
              label: 'Chế độ riêng tư (Privacy Mode)',
              kind: 'select',
              options: [
                { value: 'strict', label: 'strict (Mặc định: không lưu prompt/output/upload/auth)' },
                { value: 'metadata', label: 'metadata (Chỉ lưu metadata có cấu trúc)' },
                { value: 'debug', label: 'debug (Ghi nhiều chi tiết hơn, cần chuyển lại thủ công)' },
              ],
              hint:
                'Cảnh báo: Server không tự động chuyển về strict — khi chuyển sang debug sẽ duy trì vô thời hạn, ' +
                'bắt buộc phải chuyển lại thủ công. Chế độ debug sẽ ghi lại mẫu nội dung yêu cầu/phản hồi (tối đa ~200 ký tự). ' +
                'Chỉ nên bật tạm thời khi cần xử lý sự cố và tắt ngay sau đó.',
            },
          ],
        },
      ]}
    />
  );
}
