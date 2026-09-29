# Giao diện Quản trị WebUI của M365-Codex

`@m365-codex/web` — Frontend bảng quản trị của M365-Codex. Xây dựng bằng React + Vite + TypeScript, CSS tự viết (không dùng UI framework, không dùng gói icon bên ngoài, không kéo tài nguyên CDN).

Đây là một package con độc lập, **không nằm trong** npm workspace gốc của kho lưu trữ, có `package.json` và `package-lock.json` riêng biệt;
Sản phẩm build production được mount tĩnh dưới đường dẫn `/ui/` của server backend (dành `/admin/*` cho JSON API quản trị, hai bên không dùng chung tiền tố).

## Phát triển (Development)

```bash
cd apps/web
npm install
npm run dev
```

Mặc định dev server sẽ proxy các request `/admin`, `/v1` sang `http://127.0.0.1:8080` (cổng mặc định của backend server),
có thể ghi đè bằng biến môi trường `VITE_API_TARGET`, ví dụ:

```bash
VITE_API_TARGET=http://192.168.0.5:8080 npm run dev
```

### Phát triển độc lập không phụ thuộc backend (Chế độ Mock)

Trước khi các API backend (Tổng quan, nhóm proxy, cài đặt...) hoàn thiện, bạn có thể chuyển toàn bộ trang web sang dùng dữ liệu giả lập trong bộ nhớ:

```bash
VITE_USE_MOCK=1 npm run dev
```

Dữ liệu giả lập được định nghĩa trong `src/api/mock.ts`, toàn bộ tên miền sử dụng `*.example.invalid`, không chứa bất kỳ thông tin đăng nhập thực tế nào.
`VITE_USE_MOCK` cũng có thể được ghi vào `.env.local` (tham khảo `.env.example`).

Chế độ thực tế và chế độ Mock dùng chung một interface `AdminApi` (`src/api/adminApi.ts`),
mã nguồn các trang chỉ import `api` từ `src/api/index.ts` mà không cần bận tâm đang chạy implementation nào.

## Xây dựng (Build)

```bash
npm run build
```

Sản phẩm đầu ra được xuất vào `apps/web/dist`, với `base` cố định là `/ui/` (do backend server đảm nhiệm host tĩnh, phần còn lại của kho lưu trữ không cần chỉnh sửa).

## Kiểm thử (Test)

```bash
npm test          # Chạy một lần
npm run test:watch
```

Sử dụng vitest + @testing-library/react, bao phủ các luồng kiểm thử trọng yếu sau:

- **Bảo vệ đăng nhập (Login Guard)**: Truy cập bất kỳ trang được bảo vệ nào khi chưa đăng nhập đều bị chuyển hướng về trang đăng nhập (`src/test/loginGuard.test.tsx`).
- **Hiển thị API Key thô một lần duy nhất**: Sau khi tạo, modal hiển thị key dạng thô, không thể đóng modal trước khi tick chọn "Tôi đã lưu key này", sau khi đóng thì key thô không còn lưu lại trong DOM, danh sách chỉ hiển thị dạng mặt nạ (mask) (`src/test/apiKeyReveal.test.tsx`).
- **Hiển thị lỗi thống nhất**: `ErrorBanner` hiển thị rõ ràng và thân thiện các trường `type`/`message`/`param`/`request_id` (`src/test/errorBanner.test.tsx`).
- **Mặt nạ địa chỉ Proxy**: Danh sách proxy pool không để lộ địa chỉ đầy đủ (chứa user:pass) ra DOM (`src/test/proxyMask.test.tsx`).

Không theo đuổi độ bao phủ 100%, chỉ đảm bảo các nguyên tắc an toàn cốt lõi không bị phá vỡ.

## Cấu trúc thư mục

```text
src/
  api/          Tầng giao tiếp với server: types.ts (kiểu hợp đồng API), adminApi.ts (định nghĩa interface),
                client.ts (triển khai thực tế), mock.ts (triển khai giả lập), http.ts (bọc hàm fetch)
  auth/         Phiên đăng nhập: AuthContext (token chỉ lưu bộ nhớ + sessionStorage), RequireAuth (route guard)
  components/   Component dùng chung: Layout, StatusBadge, ErrorBanner, CopyButton, RevealApiKeyModal, v.v.
  hooks/        useAsync: Chuẩn hóa 3 trạng thái loading / error / data
  pages/        Mỗi mục điều hướng tương ứng với một trang
  styles/       CSS tự viết + biến CSS, theme.css quản lý giao diện sáng/tối, global.css quản lý layout và style component
  util/format.ts Định dạng hiển thị dấu thời gian, số byte, phần trăm, v.v.
```

## Các điểm cốt lõi về bảo mật

- Session token quản trị chỉ lưu trong React state (bộ nhớ RAM) và `sessionStorage`, tuyệt đối không ghi vào `localStorage`, và tuyệt đối không xuất hiện trong bất kỳ lệnh `console.*` nào; khi nhận mã lỗi 401 sẽ tự động xóa sạch phiên và chuyển hướng về trang đăng nhập.
- API Key dạng thô chỉ hiển thị một lần duy nhất tại thời điểm tạo, sau khi đóng popup xác nhận thì state component cũng hủy bỏ nó; API danh sách mặc định chỉ trả về chuỗi đã che mặt nạ.
- Địa chỉ Proxy trong UI cũng luôn hiển thị dạng mặt nạ, không ghép chuỗi username/password đầy đủ trong DOM.
- Mọi tài khoản, email, tên miền mẫu trong code và test fixture đều dùng giá trị giữ chỗ dạng `*.example.invalid`.

## Rủi ro đồng bộ với phía backend đã ghi nhận

WebUI được viết hoàn toàn dựa trên tài liệu hợp đồng API quản trị (`src/api/client.ts`), tuy nhiên trong quá trình phát triển giai đoạn đầu, các API tài khoản/OAuth phía backend đã có một phiên bản thực hiện trước nên có một số trường chưa khớp hoàn toàn. Frontend đã hoàn thành theo **tài liệu hợp đồng**, nếu backend giữ phiên bản cũ thì cần thống nhất theo các điểm sau:

1. **Thay đổi trạng thái tài khoản**: Hợp đồng ghi `PATCH /admin/accounts/:id` (thân request `{status}`); triển khai hiện tại của backend tại `apps/server/src/routes/accounts.ts` là `PATCH /admin/accounts/:id/status`.
2. **Tham số callback OAuth**: Hợp đồng ghi `{redirect_url}` hoặc `{code, state}`; backend hiện tại đang đọc `{callback}`. Frontend hiện đang gửi `{redirect_url: callbackUrl}`.
3. **Trường `proxy_id` trong AccountView**: `src/api/types.ts` có thêm trường này và API gán proxy `POST /admin/accounts/:id/proxy` — cả hai đều được frontend suy đoán dựa trên tài liệu hợp đồng §2.4.
4. **Các trường cụ thể của `/admin/settings`**: Tài liệu hợp đồng chỉ đưa ra tên nhóm (`network`/`scheduler`/`logging`/`oauth`/`tools`/`files`) mà không liệt kê chi tiết từng trường. Các trường trong `src/api/types.ts` được suy luận từ cấu hình `.env.example`, nếu backend có khác biệt thì chỉ cần cập nhật lại `types.ts` và `SettingFieldMeta[]` trong `SettingsGroupPage`.
5. **Các trường có thể null trong danh sách Request/Tool calls**: Tài liệu hợp đồng không đánh dấu từng trường có thể `null` hay không, các trường được đánh dấu `null` trong frontend là suy đoán theo nghiệp vụ logic, khi backend trả về cấu trúc chính thức thì sẽ đồng bộ theo backend.

Sau khi hai bên đồng bộ hoàn tất, phần ghi chú này có thể được gỡ bỏ.
