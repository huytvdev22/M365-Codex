# Hướng dẫn Triển khai và Nghiệm thu

Dành cho người tự triển khai (self-host): Cách cài đặt chạy M365-Codex và cách xác minh hệ thống thực sự hoạt động tốt.

> Đọc trước: Tuyên bố tuân thủ & rủi ro tại [README](../README.md). Dự án này là một triển khai đảo ngược (reverse engineering) phi chính thức, vui lòng xác nhận bạn chấp nhận các rủi ro được nêu trong đó trước khi sử dụng.

---

## I. Triển khai

### 1. Chuẩn bị biến môi trường

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Điền chuỗi Base64 vừa tạo vào `M365_CODEX_MASTER_KEY`, sau đó đặt một `M365_CODEX_ADMIN_PASSWORD` có độ dài tối thiểu 12 ký tự. **Nếu không có khóa chủ hợp lệ, dịch vụ sẽ từ chối khởi động** — đây là thiết kế có chủ đích nhằm tránh việc lưu trữ Token dạng văn bản thô (plaintext) vào cơ sở dữ liệu.

### 2. Khởi động

```bash
docker compose -f docker/docker-compose.yml up -d
```

Hoặc chạy trực tiếp bằng Docker:

```bash
docker run -d --name m365-codex -p 8080:8080 \
  -e M365_CODEX_MASTER_KEY="$MASTER_KEY" \
  -e M365_CODEX_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -v m365-codex-data:/data \
  foch0x97/m365-codex:latest
```

### 3. Xác minh dịch vụ đang hoạt động

```bash
curl http://127.0.0.1:8080/healthz   # Kiểm tra tiến trình còn sống
curl http://127.0.0.1:8080/readyz    # Kiểm tra khóa chủ, migration CSDL, quyền ghi thư mục dữ liệu
```

Nếu bất kỳ mục kiểm tra nào của `/readyz` không đạt, server sẽ trả về mã lỗi 503 kèm lý do cụ thể trong thân phản hồi.

### 4. Truy cập giao diện quản trị (Admin Console)

Mở trình duyệt truy cập **`http://<địa-chỉ-của-bạn>:8080/ui/`** (truy cập vào `/` sẽ tự động chuyển hướng đến đây), đăng nhập bằng `M365_CODEX_ADMIN_PASSWORD`.

Các đường dẫn của trang quản trị và API phục vụ ra bên ngoài được tách biệt hoàn toàn:
- Giao diện người dùng: `/ui/`
- API quản trị dạng JSON: `/admin/*`
- API tương thích cho Codex: `/v1/*`

### 5. Thêm tài khoản Microsoft

Chỉ có một phương thức duy nhất: **Luồng ủy quyền PKCE** trên trang quản trị (mục "Thêm tài khoản"):

1. Bấm nút "Tạo liên kết ủy quyền"
2. Mở đường link trên trình duyệt, đăng nhập bằng tài khoản có quyền Copilot
3. Sau khi đăng nhập, hệ thống sẽ chuyển hướng đến trang thông báo `nativeclient` của Microsoft, **sao chép toàn bộ URL trên thanh địa chỉ**
4. Dán URL đó trở lại giao diện quản trị và nhấn gửi

Vì URL chuyển hướng rơi vào chính trang nội bộ của Microsoft, dịch vụ này **không cần phải mở cổng công khai ra Internet**.

### 6. Tạo API Key và Cấu hình Codex

Tại trang "API Key" của bảng quản trị, tiến hành tạo Key mới — **khóa bí mật dạng thô chỉ hiển thị duy nhất một lần này**. Sau đó, tại trang "Cấu hình Codex", sao chép đoạn mã TOML được tạo sẵn và dán vào file `~/.codex/config.toml`, đồng thời lưu API Key vào biến môi trường:

```bash
export M365_CODEX_API_KEY=sk-...
```

---

## II. Danh mục Nghiệm thu (Acceptance Checklist)

Thực hiện tuần tự theo danh sách kiểm tra dưới đây để xác nhận việc triển khai đã hoàn tất tốt đẹp:

### Kiểm tra cơ bản

| Mục kiểm tra | Cách thực hiện | Kết quả kỳ vọng |
|---|---|---|
| Tiến trình còn sống | `curl /healthz` | `{"status":"ok"}` |
| Sẵn sàng phục vụ | `curl /readyz` | `{"status":"ready"}`, toàn bộ các mục kiểm tra đều ok |
| Truy cập trang quản trị | Mở `/ui/` trên trình duyệt | Xuất hiện trang đăng nhập, sau khi nhập mật khẩu vào được trang tổng quan |
| Kiểm tra xác thực | Gọi `/v1/models` không kèm API Key | Trả về mã lỗi 401 |
| Sai mật khẩu | Nhập sai mật khẩu trên trang quản trị | Báo lỗi 401, nếu sai liên tục sẽ bị kích hoạt giới hạn tần suất (throttle) |

### Kiểm tra API đối ngoại

| Mục kiểm tra | Cách thực hiện | Kết quả kỳ vọng |
|---|---|---|
| Danh sách mô hình | `GET /v1/models` (kèm Key) | Trả về danh mục các model hỗ trợ |
| Không dùng luồng (Non-streaming) | `POST /v1/responses` | Trả về đối tượng Response hoàn chỉnh |
| Dùng luồng (Streaming) | Thêm `"stream":true` vào request trên | Trả về luồng sự kiện SSE, `sequence_number` tăng dần đều đặn, kết thúc bằng `response.completed` |
| Tải tệp lên | `POST /v1/files` (multipart) | Trả về 201 kèm file id |
| Tham chiếu tệp đính kèm | Gửi `input_file` kèm file id đã tải | Nội dung văn bản của tài liệu được chèn chuẩn xác vào ngữ cảnh |
| Nhập hình ảnh | Request chứa `input_image` | Mặc định trả về lỗi 422 giải thích rõ nguyên nhân (chưa hiệu chuẩn năng lực upstream, không giả vờ hỗ trợ) |
| Tương thích Chat Completions | `POST /v1/chat/completions` | Trả về đối tượng định dạng `chat.completion` |

### Kiểm tra Codex End-to-End

Sau khi cấu hình xong tệp `config.toml`:

```bash
codex exec "Hãy chạy lệnh echo hello và thông báo kết quả cho tôi"
```

Kỳ vọng sẽ quan sát thấy toàn bộ vòng lặp ủy quyền hoàn chỉnh: Codex nhận yêu cầu gọi công cụ → **Thực thi lệnh ngay trên máy cục bộ của bạn** → Gửi kết quả ngược lại cho mô hình → Nhận được câu trả lời cuối cùng.

Các tính năng có thể kiểm thử mở rộng: Hội thoại nhiều lượt, đọc ghi tệp cục bộ, `apply_patch`, Git, MCP, chuyển đổi giữa các `model` và mức `model_reasoning_effort` (cả hai đều được chuyển tiếp nguyên trạng, không bị gateway thay đổi).

> **Lưu ý**: Theo mặc định, Codex có thể khai báo một số công cụ được OpenAI quản lý trên đám mây như `web_search`. Gateway này không thể thực thi các công cụ đó nên sẽ tự động bỏ qua và liệt kê trong header phản hồi `x-m365-codex-skipped-tools`. Đây không phải là lỗi mà là thông báo các công cụ đó sẽ không có hiệu lực.

---

## III. Cách nghiệm thu khi không có tài khoản thật

Thư mục `dev/` trong kho lưu trữ cung cấp một môi trường nghiệm thu giả lập độc lập với Microsoft, dùng để kiểm tra bản thân gateway (giao thức, SSE, vòng lặp công cụ, tệp đính kèm, hạn mức):

```bash
# 1. Khởi động một mock server giả lập upstream Sydney
node dev/mock-sydney.mjs --port 4300

# 2. Trỏ gateway đến mock server
export UPSTREAM_WS_BASE=ws://127.0.0.1:4300
export UPSTREAM_PATH_TEMPLATE='/chat/{oid}@{tid}'

# 3. Tạo một tài khoản giả lập (vì tài khoản chỉ được thêm qua PKCE do ràng buộc bảo mật,
#    nên môi trường nghiệm thu cần script này để bỏ qua bước đăng nhập tương tác)
M365_CODEX_MASTER_KEY=... node dev/seed-mock-account.mjs --db ./data/m365-codex.sqlite
```

Mock upstream này sẽ mô phỏng một "mô hình biết gọi công cụ": Khi có khai báo công cụ và yêu cầu có tính chất hành động, mô hình sẽ trả về lời gọi công cụ; sau khi nhận được kết quả công cụ sẽ đưa ra phản hồi tổng kết trích dẫn kết quả đó.

* **Môi trường này kiểm chứng được gì**: Giao thức Responses, luồng sự kiện SSE, vòng lặp ủy quyền công cụ, đưa tệp đính kèm vào ngữ cảnh, kiểm tra hạn mức & xác thực, toàn bộ tính năng giao diện quản trị.
* **Môi trường này không kiểm chứng được gì**: Liệu Microsoft 365 Copilot thật có phản hồi đúng theo cấu trúc đã mô hình hóa hay không — phần này bắt buộc phải kiểm tra bằng tài khoản thật.

---

## IV. Xử lý sự cố: Lỗi 403 và InvalidCopilotLicense

Hai lỗi thường gặp nhất trong môi trường thực tế, có biểu hiện bề ngoài khá giống "tài khoản không có quyền", nhưng nguyên nhân gốc rễ hoàn toàn khác nhau:

### Trường hợp 1: Bắt tay WebSocket nhận mã 403, thân phản hồi rỗng

Không phải lỗi do tài khoản, mà là **thiếu header `X-Scenario` trong request**.

Phía upstream khi thiếu header này sẽ phản hồi mã 403 rỗng từ `Microsoft-HTTPAPI/2.0` — không có body, không có `WWW-Authenticate`, không có bất kỳ mô tả lỗi nào, nhìn qua hoàn toàn giống như "tài khoản bị từ chối".

Tổ hợp tối thiểu bắt buộc đã được xác nhận thực tế:

| Mục | Mức độ bắt buộc |
|---|---|
| `X-Scenario: officeweb` | ✅ **Bắt buộc**, và giá trị phải chính xác (`bizchat` / `M365Chat` / các giá trị khác đều bị 403) |
| Thông tin xác thực (`?access_token=` hoặc `Authorization: Bearer`) | ✅ Bắt buộc, truyền qua cách nào trong hai cách đều được |
| `X-AnchorMailbox` / `X-SessionId` / `X-Variants` / `Origin` / `User-Agent` | ❌ Đều không bắt buộc |
| Đoạn `/{oid}@{tid}` trong đường dẫn | ❌ Có hay không đều kết nối được |

Header này được quản lý qua biến cấu hình `UPSTREAM_SCENARIO`, mặc định đã được điền đúng giá trị; lưu ý ghi nhớ điểm này để xử lý nhanh nếu upstream có biến động.

### Trường hợp 2: Bắt tay thành công nhưng tầng nghiệp vụ trả về `InvalidCopilotLicense`

Đây mới chính xác là vấn đề về tài khoản: **Tài khoản không có giấy phép (license) Copilot**. Xem phần "Điều kiện tiên quyết về tài khoản" ở đầu README.

Cách phân biệt rất đơn giản — xem lỗi phát sinh ở tầng nào:
- **HTTP 403, không kết nối được** → Lỗi giao thức / thiếu header
- **Kết nối được, trường `item.result.errorCode` có giá trị** → Lỗi tài khoản hoặc hạn mức, lý do được ghi rõ trong trường `message`

### Trường hợp 3: Giao diện web báo "Copilot Chat is not available in your region"

Hạn chế khu vực địa lý căn cứ theo **nơi đăng ký của Tenant (tổ chức)** chứ không căn cứ vào IP kết nối của bạn — trong thực tế kiểm nghiệm, tài khoản có tenant thuộc vùng `tenant_region_scope=AS` dù dùng IP lối ra tại Tokyo vẫn bị từ chối. **Đổi IP / VPN không có tác dụng**, chỉ có thể đổi tài khoản thuộc tenant khác.

---

## V. Các hạng mục vẫn cần tài khoản thật để xác nhận

Những nội dung sau đây phụ thuộc vào dịch vụ upstream thật, **người triển khai cần tự kiểm chứng**, các bài kiểm thử tự động của dự án chưa thể bao quát hết:

> **Các phần đã được hiệu chuẩn thì không nằm trong danh sách này**. Vào ngày 2026-07-27, dự án đã dùng tài khoản thật để chạy thông suốt quá trình bắt tay và định dạng request/response:
> Phía request, `arguments[0]` chứa **đối tượng `message` dạng số ít** (dạng mảng `messages[]` theo tài liệu công khai cũ đã bị chứng minh là sai và chưa từng chạy được với upstream thật), phía response dữ liệu nghiệp vụ nằm trong trường **`item`** (`item.messages[]` / `item.result`), không phải `arguments[0]`.
> Phần này hiện đã chuẩn hóa theo thực tế kiểm nghiệm, xem tại `adapter/codecV1.ts`.

Những điểm sau đây **vẫn chưa được kiểm chứng đầy đủ** do tài khoản dùng trước đây không có Copilot license, upstream từ chối ở tầng nghiệp vụ (`InvalidCopilotLicense`) sau khi giao thức đã đúng, nên chưa lấy được nội dung sinh ra thực tế:
- **Upstream có hỗ trợ gọi công cụ dạng cấu trúc (structured tool calls) nguyên bản hay không**. Mặc định `TOOLS_MODE=auto` sẽ đồng thời gửi cả khai báo cấu trúc lẫn ràng buộc qua prompt, và hỗ trợ bóc tách cả 2 kiểu phản hồi; sau khi xác nhận năng lực thực tế có thể thu gọn lại thành `native` hoặc `prompt`.
- **Nhập hình ảnh** có thực sự dùng được không (`UPSTREAM_IMAGE_INPUT`, mặc định tắt).
- Ngưỡng **giới hạn tần suất thực tế và phân bố mã lỗi**, từ đó điều chỉnh các tham số thời gian hạ nhiệt (cooldown) và thử lại (retry).
- Lượng token chính xác, các mức độ suy nghĩ (effort) có thực sự phân cấp hay không, phạm vi đoạn trích dẫn nguồn — những thông tin này nếu phía upstream không cung cấp thì sẽ để trống trung thực chứ không tự tạo dữ liệu giả.
