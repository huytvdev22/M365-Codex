import { SettingsGroupPage } from '../components/SettingsGroupPage';

export function SystemSettingsPage() {
  return (
    <SettingsGroupPage
      title="Cài đặt hệ thống"
      subtitle="Địa chỉ mạng, hạn mức gọi công cụ và chính sách tệp (tương ứng với nhóm network / tools / files trong /admin/settings)"
      groups={[
        {
          group: 'network',
          heading: 'Mạng',
          fields: [
            { key: 'public_api_base_url', label: 'Base URL API đối ngoại', kind: 'string', hint: 'Dùng cho WebUI, sinh cấu hình Codex và ví dụ gọi API.' },
            { key: 'public_admin_url', label: 'Địa chỉ công khai giao diện quản trị', kind: 'string' },
            { key: 'trust_proxy', label: 'Tin cậy Header Reverse Proxy', kind: 'boolean', hint: 'Bật lên mới tin tưởng Forwarded / X-Forwarded-*.' },
            { key: 'http_proxy', label: 'Địa chỉ Proxy HTTP', kind: 'string', hint: 'Proxy cho request HTTP gửi ra ngoài, để trống nếu không dùng.' },
            { key: 'https_proxy', label: 'Địa chỉ Proxy HTTPS', kind: 'string', hint: 'Proxy cho request HTTPS gửi ra ngoài, để trống nếu không dùng.' },
            { key: 'no_proxy', label: 'Danh sách loại trừ Proxy', kind: 'string', hint: 'Các hostname phân tách bằng dấu phẩy sẽ không đi qua proxy.' },
          ],
        },
        {
          group: 'tools',
          heading: 'Gọi công cụ (Tool Calls)',
          fields: [
            {
              key: 'mode',
              label: 'Chế độ gọi công cụ',
              kind: 'select',
              options: [
                { value: 'native', label: 'native (Khai báo công cụ gốc)' },
                { value: 'prompt', label: 'prompt (Mô phỏng qua prompt)' },
                { value: 'auto', label: 'auto (Kích hoạt cả 2 kênh, mặc định)' },
              ],
            },
            { key: 'max_calls_per_round', label: 'Số lần gọi tối đa mỗi lượt', kind: 'number' },
            { key: 'max_rounds', label: 'Số lượt tối đa', kind: 'number' },
            { key: 'max_total_calls', label: 'Tổng số lần gọi tối đa', kind: 'number' },
            { key: 'max_result_bytes', label: 'Dung lượng kết quả tối đa mỗi lần (bytes)', kind: 'number' },
            {
              key: 'max_arg_repairs',
              label: 'Số lần sửa tham số tối đa',
              kind: 'number',
              min: 0,
              max: 2,
              hint: 'Quy tắc giao thức giới hạn tối đa 2 lần (0-2), nhập giá trị lớn hơn server sẽ từ chối.',
            },
            { key: 'allow_parallel', label: 'Cho phép gọi công cụ song song', kind: 'boolean', hint: 'Trong cùng một lượt có cho phép thực thi đồng thời nhiều công cụ không.' },
          ],
        },
        {
          group: 'files',
          heading: 'Chính sách Tệp',
          fields: [
            { key: 'max_file_bytes', label: 'Dung lượng tối đa mỗi tệp (bytes)', kind: 'number' },
            { key: 'max_request_bytes', label: 'Dung lượng tối đa mỗi yêu cầu (bytes)', kind: 'number' },
            { key: 'max_total_bytes_per_key', label: 'Dung lượng tích lũy tối đa mỗi API Key (bytes)', kind: 'number', hint: 'Giới hạn tổng dung lượng tất cả tệp chưa hết hạn thuộc cùng một Key.' },
          ],
        },
      ]}
    />
  );
}
