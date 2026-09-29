# M365-Codex

> Sử dụng "tùy chỉnh `base_url` + khóa bí mật `sk-`" để đăng nhập vào Codex, coi Microsoft 365 Copilot là dịch vụ thượng nguồn (upstream), mang lại trải nghiệm lập trình cục bộ gần tương đương với việc đăng nhập tài khoản OpenAI chính thức.

[![CI](https://github.com/Foch0x97/M365-Codex/actions/workflows/ci.yml/badge.svg)](https://github.com/Foch0x97/M365-Codex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Phiên bản hiện tại: `v0.9.1`**

Toàn bộ tính năng đã được hiện thực và vượt qua các bài kiểm thử tự động cũng như nghiệm thu đầu-cuối (end-to-end). Giao thức upstream đã được hiệu chuẩn bằng tài khoản thật:
Bắt tay WebSocket, định dạng thân yêu cầu, phân tích gói tin phản hồi đều dựa trên lưu lượng thực tế (xem `adapter/codecV1.ts`).

**Để đạt tới `v1.0.0` chỉ còn thiếu một lần kiểm chứng "tạo nội dung thành công trên thực tế"** — tài khoản dùng để hiệu chuẩn trước đây không có giấy phép (license) Copilot hợp lệ,
nên sau khi giao thức hoàn toàn chuẩn xác, phía dịch vụ upstream đã từ chối ở tầng nghiệp vụ (`InvalidCopilotLicense`). Do đó, hình thái thực tế của dữ liệu luồng (stream chunk),
trường gọi công cụ (tool call), vị trí nhập ảnh, đo lường usage và trích dẫn tham chiếu **vẫn chưa qua kiểm chứng bằng nội dung thật**.
Chi tiết xem [Hướng dẫn triển khai và nghiệm thu](docs/部署与验收.md).

---

## ⚠️ Tuyên bố Tuân thủ & Rủi ro (Bắt buộc đọc trước khi dùng)

- Dự án này là **dự án cá nhân phi chính thức**, hoàn toàn không liên kết, không được ủy quyền hay chứng thực bởi Microsoft hoặc OpenAI.
- Phương thức truy cập Microsoft 365 Copilot của dự án này dựa trên **kỹ thuật đảo ngược (reverse engineering) giao thức WebSocket Sydney / BizChat**. Microsoft không cung cấp giao diện HTTP hoàn thành (completion) chính thức cho các proxy mô hình bên thứ ba.
- Cách truy cập này **rất có thể vi phạm Điều khoản dịch vụ của Microsoft** (các điều khoản nêu rõ nghiêm cấm kỹ thuật đảo ngược, thu thập dữ liệu và vượt qua các rào cản kỹ thuật). Việc sử dụng dự án này có thể dẫn đến:
  - Tài khoản Microsoft bị hạn chế, tạm ngưng hoặc khóa vĩnh viễn;
  - Tenant (tổ chức) liên quan bị can thiệp xử lý bởi quản trị viên hoặc Microsoft;
  - Giao thức thượng nguồn có thể thay đổi hoặc bị cắt bất cứ lúc nào, tính năng **có thể ngừng hoạt động bất kỳ lúc nào**.
- **Endpoint upstream có thể thay đổi/trôi dạt** (đã quan sát thấy cả 2 dạng `substrate.office.com` và `substrate.svc.cloud.microsoft`), do đó dự án này đã cấu hình hóa toàn bộ địa chỉ, đường dẫn và phạm vi (scope) upstream.
- Người dùng phải tự chịu toàn bộ rủi ro và hậu quả. **Tuyệt đối không dùng cho môi trường sản xuất (production), mục đích thương mại, hoặc bất kỳ tài khoản nào bạn không muốn bị mất.**
- Nếu bạn cần một dịch vụ ổn định, có hỗ trợ và tuân thủ pháp lý, vui lòng sử dụng tài khoản chính thức của OpenAI hoặc API chính thức do Microsoft cung cấp.

Tác giả không chịu trách nhiệm cho bất kỳ tổn thất tài khoản, mất mát dữ liệu hoặc hậu quả nào phát sinh từ việc sử dụng dự án này.

---

## Dự án này là gì?

Codex hỗ trợ chỉ định nhà cung cấp mô hình tùy chỉnh thông qua tệp `config.toml` (`base_url` + API Key). M365-Codex chính là một **cổng cục bộ (Local Gateway)** như vậy:

```text
Codex CLI ──HTTP (Giao thức Responses)──> M365-Codex ──WebSocket (Sydney)──> Microsoft 365 Copilot
              Khóa bí mật sk-                 Container cục bộ                Tài khoản M365 của bạn
```

Dự án mở ra giao diện tương thích với OpenAI Responses API ra bên ngoài, đồng thời bên trong duy trì nhóm tài khoản Microsoft, OAuth Token và các phiên WebSocket có trạng thái kết nối với upstream.

### Những việc có thể làm

- Đăng nhập Codex bằng Base URL tùy chỉnh + khóa bí mật `sk-`, không cần tài khoản chính thức hay thẻ thanh toán quốc tế;
- Sinh văn bản và mã nguồn, truyền luồng SSE, giữ ngữ cảnh nhiều lượt (multi-turn);
- **Chuyển tiếp nguyên trạng** `model` và `reasoning.effort` (dự án này không tự tạo bí danh model mới, cũng không sửa đổi giá trị);
- Vòng lặp ủy quyền gọi công cụ (tool call proxy loop) hoàn chỉnh: Mô hình yêu cầu gọi công cụ → Thực thi trên máy cục bộ → Gửi kết quả ngược lại → Tiếp tục suy luận;
- Các năng lực cục bộ của Codex vẫn hoạt động bình thường: Đọc ghi file, `apply_patch`, thực thi lệnh, Git, chạy kiểm thử, đánh giá mã nguồn cục bộ qua CLI, MCP cục bộ/tự dựng, `AGENTS.md`;
- Tải lên tệp và trích xuất văn bản: Văn bản thuần/mã nguồn/JSON/CSV/logs, PDF, Office (docx/xlsx/pptx) để phục vụ tham chiếu `input_file`; hỗ trợ tải lên phân đoạn qua `/v1/files`, `/v1/uploads`;
- Cổng tương thích `/v1/chat/completions` (tái sử dụng nhân Responses, phục vụ cho các client tương thích OpenAI khác, không phải bản thân Codex);
- Quản lý nhiều API Key (hạn dùng, hạn mức, thu hồi), địa chỉ công khai tùy chỉnh, giao diện quản trị trực quan.

### Những việc không thể làm (Phụ thuộc backend OpenAI, dự án này không giả lập)

Các tác vụ Codex Cloud trên đám mây, đánh giá mã và tích hợp GitHub trên cloud, các công cụ tích hợp sẵn do OpenAI quản lý (`web_search` / `file_search` / `code_interpreter` / `computer_use` / `image_generation`), RBAC không gian làm việc ChatGPT và chính sách lưu trữ doanh nghiệp, plugin và MCP phụ thuộc OpenAI, Embeddings / Realtime / Batch / Fine-tuning, bảng điều khiển thanh toán mức sử dụng chính thức.

Ngoài ra, dự án này **không thể đảm bảo** rằng `model` bạn yêu cầu sẽ được upstream thực sự sử dụng — việc upstream thực tế sử dụng mô hình nào hoàn toàn do Microsoft quyết định, dự án này chỉ ghi lại và báo cáo trung thực.

### Các năng lực phụ thuộc vào kết quả dò quét upstream thực tế

Hiểu hình ảnh, tệp đính kèm PDF/Office, giới hạn ngữ cảnh dài, JSON cấu trúc nghiêm ngặt, gọi công cụ song song, cấp độ suy nghĩ (effort) có thực sự phân cấp hay không, lượng token chính xác, nguồn trích dẫn, tính kịp thời của việc hủy yêu cầu — các khả năng này có hoạt động hay không phụ thuộc vào kết quả dò quét upstream thực tế; các tính năng chưa đạt tiêu chuẩn sẽ không được bật mặc định.

---

## ⚠️ Điều kiện tiên quyết về tài khoản (Cần xác nhận trước)

Dự án này sử dụng **Microsoft 365 Copilot bản trả phí** làm dịch vụ upstream. Tài khoản của bạn bắt buộc phải **được cấp phép Copilot (Copilot license)**.

**Các gói đăng ký cơ bản như E3 / A3 / E5 / A5 không bao gồm Copilot** — Copilot là một **gói bổ sung (add-on)** cần mua riêng và phân bổ riêng trên nền các gói đăng ký cơ bản. Khi chỉ có gói đăng ký cơ bản, phía upstream sẽ từ chối rõ ràng ở tầng nghiệp vụ:

```json
{"value":"ForbiddenRequest","errorCode":"InvalidCopilotLicense",
 "message":"It looks like you don't have a valid license. To get access, please check with your administrator."}
```

Sự từ chối này **diễn ra sau khi toàn bộ giao thức đã hoàn toàn chính xác** — Xác thực OAuth thành công, audience và scope của token hoàn toàn đúng, bắt tay WebSocket thông suốt, thân yêu cầu được phân tích và phản hồi chuẩn. Vì vậy "đăng nhập được, refresh token được" hoàn toàn không đồng nghĩa với việc có thể sử dụng được.

Ngoài ra cần lưu ý hai điểm dễ nhầm lẫn:

- **Copilot Chat (tầng miễn phí)** và Copilot trả phí mà dự án này tích hợp là **hai dịch vụ khác nhau** với các endpoint hoàn toàn khác nhau. Có tài khoản miễn phí không có nghĩa là dùng được dự án này.
- **Hạn chế khu vực địa lý tồn tại độc lập**: Ngay cả khi có giấy phép, Copilot vẫn không cung cấp dịch vụ ở một số khu vực, và việc kiểm tra này căn cứ theo **nơi đăng ký của Tenant (tổ chức)** chứ không căn cứ vào IP mạng của bạn — **dùng VPN / Proxy không có tác dụng**.

Cách kiểm tra: Trung tâm quản trị Microsoft 365 → Người dùng → Giấy phép (Licenses), xem có dòng riêng biệt "Microsoft 365 Copilot" (hoặc SKU dòng A tương ứng cho bản giáo dục). Nếu chỉ có E3/A3 mà không có dòng này nghĩa là tài khoản thiếu add-on.

---

## Bắt đầu nhanh

> Điều kiện tiên quyết: Một tài khoản Microsoft 365 **đã được cấp giấy phép Copilot** (các bước ủy quyền được thực hiện trên giao diện quản trị).

### 1. Chuẩn bị biến môi trường

```bash
cp .env.example .env
```

Tạo khóa chủ chính (Base64, sau khi giải mã có độ dài 32 bytes):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Điền kết quả vào `M365_CODEX_MASTER_KEY` trong file `.env`, đồng thời thiết lập `M365_CODEX_ADMIN_PASSWORD` (ít nhất 12 ký tự).

**Nếu không có khóa chủ hợp lệ, dịch vụ sẽ từ chối khởi động** — Đây là thiết kế có chủ đích nhằm tránh việc lưu trữ Token dạng văn bản thô (plaintext) vào cơ sở dữ liệu.

### 2. Chạy bằng Docker

Image được phát hành trên **Docker Hub**: [`foch0x97/m365-codex`](https://hub.docker.com/r/foch0x97/m365-codex), hỗ trợ đa kiến trúc (`linux/amd64` + `linux/arm64`).

```bash
docker pull foch0x97/m365-codex:latest
```

Quy tắc tag: `latest` theo sát bản phát hành Release chính thức mới nhất; `0.9.1` / `0.9` tạo từ tag phiên bản; `main` và `sha-<mã băm ngắn>` theo sát commit mới nhất của nhánh main.

```bash
docker compose -f docker/docker-compose.yml up -d
```

Kiểm tra trạng thái:

```bash
curl http://127.0.0.1:8080/healthz
```

Endpoint `/readyz` sẽ kiểm tra thêm tính sẵn sàng của khóa chủ, migration cơ sở dữ liệu, quyền ghi thư mục dữ liệu; nếu bất kỳ mục nào không đạt sẽ trả về 503.

### 3. Truy cập giao diện quản trị

Mở trình duyệt truy cập **`http://<địa-chỉ-của-bạn>:8080/ui/`** (truy cập `/` sẽ tự động chuyển hướng sang đây),
đăng nhập bằng `M365_CODEX_ADMIN_PASSWORD`.

Ba nhóm đường dẫn được tách biệt rõ ràng, thuận tiện cho việc kiểm soát sau reverse proxy:

| Đường dẫn | Mục đích | Cơ chế xác thực |
|---|---|---|
| `/ui/` | Trang giao diện quản trị Web | Đăng nhập trên trang (Mật khẩu admin → Phiên session token) |
| `/admin/*` | JSON API quản trị | Session token quản trị |
| `/v1/*` | Giao diện tương thích cho Codex và các client khác | `sk-` API Key |

Ủy quyền tài khoản, tạo API Key, sinh cấu hình Codex, xem trạng thái yêu cầu và tài khoản, nhóm proxy, sao lưu và phục hồi đều được thực hiện trên giao diện quản trị. Chi tiết các bước xem tại [Hướng dẫn triển khai và nghiệm thu](docs/部署与验收.md).

### 4. Chạy trong môi trường phát triển cục bộ (Local Dev)

```bash
npm ci
npm ci --prefix apps/web   # Giao diện quản trị không nằm trong root workspace, cần cài riêng
npm run build              # Xây dựng đồng thời cả backend server và frontend web
npm run dev
```

### 5. Cấu hình Codex

Bạn có thể sinh nhanh cấu hình trên giao diện quản trị với 1 cú click, hoặc tự chỉnh sửa file `~/.codex/config.toml`:

```toml
model = "gpt-5-codex"            # Do phía Codex lựa chọn, container không sửa đổi
model_reasoning_effort = "high"  # Giá trị tùy thuộc vào model, chuyển tiếp nguyên trạng
model_provider = "m365-codex"

[model_providers.m365-codex]
name = "M365-Codex (Responses compatible)"
base_url = "https://codex.example.com/v1"
env_key = "M365_CODEX_API_KEY"
wire_api = "responses"           # Chỉ hỗ trợ responses, chat đã bị gỡ bỏ từ 2026-02
```

Sau đó gán khóa bí mật `sk-` được tạo từ giao diện quản trị vào biến môi trường `M365_CODEX_API_KEY`.

---

## Các mục cấu hình

Danh sách đầy đủ xem tại [.env.example](.env.example). Các điểm cốt lõi:

| Biến môi trường | Bắt buộc | Mô tả |
|---|---|---|
| `M365_CODEX_MASTER_KEY` | Có | Base64, sau giải mã đúng 32 bytes; không hợp lệ sẽ từ chối ready |
| `M365_CODEX_ADMIN_PASSWORD` | Có | Mật khẩu đăng nhập trang quản trị, tối thiểu 12 ký tự |
| `PORT` | Không | Mặc định `8080` |
| `DATA_DIR` | Không | Mặc định `/data` |
| `PUBLIC_API_BASE_URL` | Không | Base URL API công khai ra ngoài, dùng để sinh cấu hình Codex |
| `TRUST_PROXY` | Không | Bật lên mới tin tưởng các header `X-Forwarded-*` |
| `LOG_PRIVACY_MODE` | Không | `strict` (mặc định) / `metadata` / `debug` |
| `UPSTREAM_WS_BASE` | Không | Địa chỉ cơ sở WebSocket thượng nguồn, dùng khi endpoint bị thay đổi |
| `OAUTH_*` | Không | Client ID, endpoint và scope OAuth, để trống sẽ dùng mặc định tích hợp sẵn |
| `UPSTREAM_*` | Không | Mẫu đường dẫn upstream, phiên bản giao thức, heartbeat/timeout/reconnect |
| `TOOLS_*` | Không | Phương thức gọi công cụ (`native`/`prompt`/`auto`) và giới hạn vòng lặp: số lần gọi mỗi lượt, số lượt, tổng số lần gọi, kích thước kết quả, số lần sửa tham số |
| `FILES_*` | Không | Giới hạn dung lượng đơn tệp/đơn yêu cầu, giới hạn lưu trữ tích lũy mỗi Key, thời gian lưu file, thời gian sống của Upload chưa hoàn tất |
| `UPSTREAM_IMAGE_INPUT` | Không | Upstream có thực sự hỗ trợ ảnh không, mặc định `false` (`input_image` sẽ trả về lỗi rõ ràng chứ không giả vờ hỗ trợ) |
| `CONTEXT_MAX_CHARS` | Không | Ngưỡng ký tự tối đa của ngữ cảnh hội thoại; vượt quá sẽ cắt tỉa từ lịch sử cũ nhất |
| `RATE_LIMIT_GLOBAL_*` | Không | Giới hạn trần toàn cục cấp API Key (RPM/hạn mức ngày/concurrency tối đa); từng Key chỉ có thể cấu hình chặt hơn mức này |
| `CLEANUP_*` | Không | Khoảng thời gian chạy dọn dẹp định kỳ và thời hạn lưu trữ Response/nhật ký kiểm toán/bản ghi idempotent |
| `PROXY_CHECK_TIMEOUT_MS` | Không | Thời gian chờ kiểm tra sức khỏe proxy gửi ra ngoài, mặc định `5000` |
| `METRICS_ENABLED` | Không | Có mở `GET /metrics` không, mặc định `true` |
| `METRICS_REQUIRE_AUTH` | Không | `/metrics` có yêu cầu xác thực phiên admin không, mặc định `true` (tránh để lộ số lượng tài khoản và phân bổ lỗi ra ngoài) |
| `BACKUP_RETENTION_COUNT` | Không | Số lượng bản sao lưu được giữ lại, vượt quá sẽ xóa bản cũ nhất, mặc định `7` |

**Nghiêm cấm** truyền bất kỳ Microsoft Token hoặc thông tin đăng nhập OAuth nào qua biến môi trường. Khi khởi động, dịch vụ sẽ kiểm tra các tên biến phổ biến này và từ chối chạy; các thông tin này chỉ được cấp phép qua luồng PKCE và được mã hóa AES-256-GCM khi lưu vào CSDL.

---

## Thêm tài khoản Microsoft

Chỉ có một cách duy nhất: Thông qua **luồng ủy quyền PKCE** tích hợp sẵn của Gateway.

1. Gọi `POST /admin/oauth/authorize-url` để lấy liên kết ủy quyền
2. Mở trên trình duyệt, chọn tài khoản có quyền Copilot để đăng nhập
3. Sau khi đăng nhập sẽ chuyển tiếp đến trang nhắc `nativeclient` của Microsoft, sao chép toàn bộ URL trên thanh địa chỉ
4. Dán URL đó vào `POST /admin/oauth/callback`

Vì callback rơi vào chính trang nội bộ của Microsoft, **dịch vụ này không cần mở ra Internet công khai**, cũng không cần mở endpoint callback ra ngoài. Phiên ủy quyền hết hạn sau 10 phút, mã ủy quyền (code) chỉ dùng 1 lần, hỗ trợ ủy quyền song song nhiều tài khoản. Sau khi ủy quyền, dịch vụ sẽ tự động gia hạn độc lập bằng `refresh_token` được lưu trữ an toàn.

### Trạng thái tài khoản

Mỗi tài khoản sẽ ở một trong các trạng thái sau: `probing` (đang chờ dò quét), `online`, `busy`, `cooldown` (đang hạ nhiệt do rate limit), `reauth_required` (refresh token hết hiệu lực, cần ủy quyền lại), `disabled` (quản trị viên tắt thủ công), `unsupported` (năng lực upstream không đáp ứng), `error`.

Khi refresh token hết hiệu lực, tài khoản sẽ tự động chuyển sang `reauth_required` và dừng thử lại; tài khoản bị tắt thủ công sẽ không bị tự động bật lại khi thực hiện ủy quyền lại.

---

## Khả năng quan sát & Sao lưu phục hồi

### `GET /metrics`

Định dạng văn bản chuẩn Prometheus, bao gồm lượng yêu cầu và độ trễ (theo endpoint/status), các cuộc gọi upstream và phân loại lỗi, số lần gián đoạn SSE, số lượng và số lượt gọi công cụ, kết quả kiểm tra tham số công cụ (pass/rejected), kết quả refresh token, biến chuyển trạng thái tài khoản, số lần từ chối do vượt hạn mức, cùng các chỉ số tức thời khi scrape (số tài khoản theo từng trạng thái, số request đang xử lý, dung lượng CSDL và tệp).

- `METRICS_ENABLED` (mặc định `true`): Tắt đi thì endpoint sẽ trả về 404 như không tồn tại;
- `METRICS_REQUIRE_AUTH` (mặc định `true`): Chỉ số sẽ để lộ số lượng tài khoản và phân loại lỗi, mặc định yêu cầu xác thực phiên admin (`Authorization: Bearer <admin-token>`); chỉ nên tắt khi scraper nằm trong cùng mạng nội bộ tin cậy.

**Nguyên tắc bảo vệ quyền riêng tư**: Không bao giờ đưa email, prompt, nội dung output, token, tên file vào metrics; các giá trị nhãn (labels) đều được lọc qua danh sách trắng ký tự, các giá trị quá dài hoặc có định dạng giống Token/API Key sẽ bị thay thế hoặc cắt ngắn.

### Sao lưu và phục hồi

- `POST /admin/backup`: Tạo gói sao lưu (CSDL dùng `VACUUM INTO` để tạo snapshot nhất quán + các tệp đã upload), lưu tại `<DATA_DIR>/backups/`, trả về `{id, bytes, created_at}`.
- `GET /admin/backup`: Liệt kê các bản sao lưu; `GET /admin/backup/:id/download`: Tải bản sao lưu về.
- `POST /admin/restore`: Tải lên gói sao lưu qua multipart, kiểm tra phiên bản định dạng, cấu trúc CSDL, phiên bản Master Key nhất quán rồi ghi đè vào thư mục dữ liệu — **Kiểm tra thành công chỉ đại diện cho việc dữ liệu đã ghi xuống đĩa, bắt buộc phải khởi động lại dịch vụ mới có hiệu lực** (tiến trình đang chạy vẫn giữ kết nối đến CSDL cũ).
- **Master Key không nằm trong gói sao lưu**: Token trong CSDL vẫn là bản mã hóa, khi phục hồi sang máy khác bắt buộc phải cung cấp cùng một `M365_CODEX_MASTER_KEY` mới giải mã được.
- Bản sao lưu được tự động dọn dẹp theo `BACKUP_RETENTION_COUNT` (mặc định 7 bản).
- `GET /admin/diagnostics`: Gói chẩn đoán đã khử dữ liệu nhạy cảm — phiên bản, schema version, phân bố trạng thái tài khoản, kiểm tra readiness, trạng thái tác vụ bảo trì, cấu hình tóm tắt, thống kê lỗi để phục vụ báo cáo sự cố.

---

## Thiết kế An toàn & Bảo mật

- **Lưu trữ Token mã hóa**: AES-256-GCM, mỗi trường nhạy cảm dùng một nonce ngẫu nhiên độc lập, ghi nhận phiên bản khóa để hỗ trợ xoay vòng khóa; Master Key chỉ lấy từ biến môi trường, không có giá trị mặc định. Dữ liệu mã hóa ràng buộc với ID tài khoản dưới dạng AAD, chuyển sang dòng tài khoản khác sẽ không thể giải mã.
- **PKCE chuẩn S256**: Không hỗ trợ chế độ giáng cấp `plain`; `code_verifier` cũng được mã hóa khi lưu CSDL; mã ủy quyền được tiêu thụ thông qua UPDATE nguyên tử (atomic) đảm bảo chỉ dùng 1 lần.
- **Chống xung đột khi Refresh Token (Single-flight)**: Nhiều yêu cầu đồng thời trên cùng một tài khoản sẽ dùng chung một tác vụ refresh, tránh ghi đè làm hỏng `refresh_token`; ghi đè được thực hiện nguyên tử trong transaction.
- **Không lưu API Key dạng văn bản thô**: Cấu trúc `sk-` + 52 ký tự CSPRNG Base62; cơ sở dữ liệu chỉ lưu `SHA-256(Salt riêng từng Key ‖ Key)` và tiền tố dùng để đánh index; văn bản thô chỉ hiển thị một lần duy nhất lúc tạo.
- **So sánh thời gian hằng số (Timing-safe)**: So sánh API Key và mật khẩu admin đều dùng `timingSafeEqual`, ngăn chặn tấn công kênh phụ (timing side-channel).
- **Khử nhạy cảm nhật ký (Log Masking)**: Chế độ `strict` không ghi lại thân yêu cầu và prompt, địa chỉ IP chỉ giữ dải mạng (IPv4 `/24`, IPv6 `/48`); các trường `authorization`, `access_token`, `password` luôn được thay thế bằng `[ĐÃ KHỬ NHẠY CẢM]` ở mọi chế độ.
- **Chống brute-force đăng nhập**: Đăng nhập thất bại được đếm theo IP, thất bại 8 lần trong 15 phút sẽ tạm thời từ chối.
- **Gia cố Container**: Chạy dưới quyền non-root, hệ thống tệp gốc ở chế độ read-only, `no-new-privileges`, Healthcheck, xử lý tín hiệu thoát mềm SIGTERM; image không chứa devDependencies, file tài khoản, `.env` hay bất kỳ Token nào.

---

## Ngăn xếp công nghệ (Tech Stack)

TypeScript + Node.js ≥22 + Fastify; SQLite (WAL, sử dụng module tích hợp sẵn `node:sqlite` của Node, không có dependency biên dịch native); Kiểm tra dữ liệu Zod; Ghi log Pino; Mã hóa AES-256-GCM; Kiểm thử Vitest. Đơn tiến trình trong một container duy nhất, cổng mặc định `8080`, thư mục dữ liệu `/data`.

## Lệnh phát triển

```bash
npm ci             # Cài đặt dependencies
npm run build      # Xây dựng dự án
npm run typecheck  # Kiểm tra kiểu TypeScript (bao gồm cả file test)
npm run lint       # Kiểm tra ESLint
npm test           # Chạy unit test và integration test
npm run dev        # Chạy môi trường phát triển (hot reload)
```

## Đóng góp & Giấy phép

Dự án được phát hành dưới [Giấy phép MIT](LICENSE). Khai báo các thư viện phụ thuộc bên thứ ba xem tại [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Trước khi gửi Pull Request, vui lòng đảm bảo `npm run typecheck`, `npm run lint`, `npm test` đều vượt qua và **tuyệt đối không chứa bất kỳ thông tin đăng nhập thực tế nào**.
