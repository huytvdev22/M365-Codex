# Đầu dò Kiểm định Năng lực Thượng nguồn M365-Codex (M0 Probe)

Sử dụng tài khoản Microsoft 365 Copilot thật để chạy qua một bộ kiểm thử cố định, tạo ra một **báo cáo năng lực đã khử dữ liệu nhạy cảm**,
từ đó hiệu chuẩn các trường dữ liệu trong `apps/server/src/adapter/codecV1.ts` và các biến cấu hình như `TOOLS_MODE`,
`UPSTREAM_IMAGE_INPUT`. Đây là cột mốc M0 (tiêu chuẩn đầu vào bắt buộc).

## ⚠️ Cảnh báo Rủi ro (Bắt buộc đọc trước)

Dịch vụ upstream mà M365-Codex dựa vào là giao thức WebSocket Sydney/BizChat **không công khai, thu được qua kỹ thuật đảo ngược**, và yêu cầu
sử dụng token tài khoản Microsoft của chính bạn. Cách dùng này **rất có thể vi phạm Điều khoản dịch vụ của Microsoft**, có thể kích hoạt
hệ thống kiểm soát rủi ro, thay đổi quyền hạn hoặc thậm chí khóa tài khoản; giao thức upstream có thể thay đổi bất kỳ lúc nào khiến việc dò quét thất bại. Công cụ này và báo cáo của nó **không cấu thành bất kỳ cam kết tương thích chính thức nào**, chỉ phục vụ mục đích học tập và đánh giá cá nhân. Vui lòng chỉ thao tác trên tài khoản và dữ liệu mà bạn có toàn quyền sử dụng, và tự đánh giá các chính sách tổ chức, pháp lý cũng như rủi ro tài khoản.

Vì vậy:

- CLI bắt buộc phải thêm cờ `--i-understand-the-risk` một cách tường minh thì mới thực sự gửi yêu cầu lên upstream; nếu không có cờ này thì chỉ liệt kê danh sách tài khoản.
- Mặc định thực thi **tuần tự**, chèn khoảng nghỉ `--delay-ms` (mặc định 1000ms) giữa các test case, không gửi dồn dập đồng thời lên tài khoản.
- Không chủ động tạo ra các lỗi 401/403/429 (ví dụ cố ý dùng Token hỏng) để kích hoạt phân loại lỗi — việc đó tiềm ẩn nguy cơ kích hoạt kiểm soát rủi ro; các trường hợp phân loại lỗi được quan sát thụ động (xem mục "Giải thích test case" #24/#25 dưới đây).
- Bất kỳ một test case nào thất bại cũng không làm gián đoạn toàn bộ phiên kiểm thử, chỉ ghi nhận phân loại lỗi của mục đó và tiếp tục chạy mục tiếp theo.

## Điều kiện tiên quyết

1. Tài khoản chỉ có thể được thêm qua luồng ủy quyền PKCE của gateway (đây là ràng buộc bảo mật có chủ đích), do đó hãy đảm bảo cơ sở dữ liệu của `apps/server` đã có ít nhất một tài khoản ở trạng thái `online` (thêm tài khoản bình thường qua giao diện gateway).
2. Đầu dò tái sử dụng mã adapter của `apps/server`, **import trực tiếp từ bản build `apps/server/dist`**, không viết lại một WebSocket client mới, cũng không can thiệp sửa đổi `apps/server/**`. Do đó trước khi chạy phải build server trước:

   ```bash
   # Tại thư mục gốc của kho lưu trữ
   npm run build:server
   ```

   Nếu chỉ sửa đổi mã nguồn của probe mà không sửa `apps/server`, không cần build lại server. Nhưng nếu `apps/server/dist` đã được build từ lâu và mã nguồn `apps/server/src` có cập nhật sau đó, probe sẽ dùng **dist cũ** — hãy luôn đảm bảo dist đã được cập nhật trước khi chạy probe.

3. Cài đặt dependencies riêng của probe (package con độc lập, không nằm trong workspace gốc):

   ```bash
   cd probe
   npm install
   ```

## Hướng dẫn sử dụng dòng lệnh (CLI) đầy đủ

```bash
# 1. Liệt kê các tài khoản khả dụng trong CSDL (không gửi bất kỳ request nào lên upstream, không cần --i-understand-the-risk)
M365_CODEX_MASTER_KEY=<khóa_chủ_giống_gateway> \
  npx tsx src/index.ts --db ../data/m365-codex.sqlite --list

# 2. Chạy toàn bộ 29 hạng mục cho một tài khoản chỉ định
M365_CODEX_MASTER_KEY=<khóa_chủ_giống_gateway> \
  npx tsx src/index.ts \
    --db ../data/m365-codex.sqlite \
    --account <account-id> \
    --i-understand-the-risk \
    --refresh-first \
    --repeat 20 \
    --delay-ms 1000

# 3. Chạy kiểm tra toàn bộ tài khoản trong CSDL (dùng để so sánh chéo sự khác biệt năng lực giữa các tài khoản/tenant)
M365_CODEX_MASTER_KEY=<khóa_chủ_giống_gateway> \
  npx tsx src/index.ts --db ../data/m365-codex.sqlite --all --i-understand-the-risk
```

### Giải thích tham số

| Tham số | Giá trị mặc định | Mô tả |
| --- | --- | --- |
| `--db <đường_dẫn>` | `./data/m365-codex.sqlite` | Đường dẫn đến file CSDL SQLite của gateway |
| `--account <id>` | Không | Chỉ chạy cho tài khoản chỉ định; nếu không truyền và không có `--all` sẽ liệt kê danh sách tài khoản |
| `--all` | Tắt | Chạy cho tất cả tài khoản có trong CSDL |
| `--list` | Tắt | Chỉ liệt kê tài khoản, không tiến hành kiểm thử |
| `--refresh-first` | Tắt | Bắt buộc refresh Token một lần trước khi kiểm thử (đồng thời kiểm chứng mục #22/#23) |
| `--repeat <N>` | `20` | Số lần lấy mẫu cho các ca kiểm thử thống kê (4 tiêu chuẩn của tool call) |
| `--delay-ms <ms>` | `1000` | Khoảng nghỉ giữa các test case và giữa các lần lấy mẫu thống kê |
| `--invocation-timeout-ms <ms>` | `60000` | Thời gian chờ tối đa cho một lần gọi |
| `--i-understand-the-risk` | Tắt | Bắt buộc thêm cờ này mới thực sự gửi yêu cầu lên upstream |

Biến môi trường:

- `M365_CODEX_MASTER_KEY` (Bắt buộc): Khóa mã hóa chủ giống với gateway, dùng để giải mã Token trong CSDL.
- `MASTER_KEY_VERSION` (Tùy chọn, mặc định `1`): Phiên bản khóa chủ giống với gateway.
- `UPSTREAM_WS_BASE` / `UPSTREAM_PATH_TEMPLATE` / `UPSTREAM_PROTOCOL_VERSION` / `UPSTREAM_HEARTBEAT_INTERVAL_MS` / `UPSTREAM_HANDSHAKE_TIMEOUT_MS` / `UPSTREAM_IDLE_TIMEOUT_MS` (Tùy chọn): Đồng bộ với cấu hình gateway; dùng khi trỏ đầu dò vào mock upstream hoặc endpoint mới khi có sự thay đổi.
- `PROBE_OUT_DIR` (Tùy chọn): Thư mục xuất báo cáo, mặc định `probe/out/`.

## Sản phẩm Báo cáo đầu ra

`probe/out/probe-<dấu thời gian ISO>.md` (dành cho người đọc) + `probe/out/probe-<cùng dấu thời gian>.json` (dành cho máy đọc):

- Bảng trạng thái của 29 năng lực (`native` / `adaptable` / `partial` / `unsupported` / `unstable` / `unknown`).
- Đánh giá từng tiêu chuẩn đạt/không đạt + kết luận tổng thể ("Có thể tiến hành phát triển hoàn chỉnh" / "Cần thu hẹp phạm vi phát hành ban đầu").
- Nếu việc gọi công cụ chỉ có thể mô phỏng qua prompt, báo cáo sẽ đính kèm 4 chỉ số thống kê (tỷ lệ nhận diện tên công cụ, tỷ lệ tham số hợp lệ lần đầu, tỷ lệ hợp lệ sau 2 lần sửa lỗi, số lần gọi công cụ không được khai báo, số lần lặp lại nội dung) kèm ngưỡng đối chiếu.
- Đề xuất hiệu chuẩn: Danh sách sai lệch giữa các trường frame thực tế quan sát được và các trường trong `codecV1.ts`, giá trị gợi nghị cho `TOOLS_MODE`, có nên bật `UPSTREAM_IMAGE_INPUT` hay không, ngưỡng giới hạn tần suất quan sát được và hành vi Retry-After.
- Nếu chạy `--all` cho nhiều tài khoản, cuối báo cáo sẽ có bảng so sánh ngang "Sự khác biệt năng lực giữa các tài khoản / tenant".

Thư mục `probe/out/` và `probe/samples/` đã nằm trong `.gitignore` gốc, các file báo cáo đầu ra sẽ không bị commit vào git.

## 29 Hạng mục Kiểm thử (Test Cases)

Đầu dò hoạt động tại **tầng adapter**: Kết nối trực tiếp vào Sydney WebSocket, không đi qua toàn bộ Responses gateway. Mỗi test case mở độc lập một hoặc vài kết nối WebSocket (`src/rawSession.ts`), không chia sẻ trạng thái biến đổi với nhau, lỗi ở một mục không ảnh hưởng đến các mục khác.

| # | Năng lực | Phương thức kiểm tra |
| --- | --- | --- |
| 1 | Bắt tay WebSocket và xác thực | Kết nối + Bắt tay + Gửi đoạn văn bản ngắn cố định, kiểm tra xem có nhận được frame phản hồi bất kỳ nào không |
| 2 | Đối thoại văn bản thông thường | Gửi văn bản ngắn cố định, kiểm tra xem có nhận được phản hồi văn bản không rỗng |
| 3 | Phản hồi văn bản dạng luồng (Streaming) | Đếm số lượng sự kiện `text_delta` trong 1 lượt: ≥2 coi là luồng thật, 1 sự kiện coi là trả về một lần duy nhất |
| 4 | Hiểu hình ảnh | Đầu dò tự sinh một ảnh PNG đơn sắc 4x4 (không dùng file người dùng), gửi qua quy ước `passthrough.images`, hỏi xem phản hồi có nhắc đúng màu sắc không |
| 5 | Tệp đính kèm văn bản | So sánh hiệu quả giữa cách "trích xuất nội tuyến vào văn bản" với cách "dùng trường attachments tùy biến của probe" |
| 6 | Tệp đính kèm PDF và Office | Tương tự trên, dùng một đoạn "văn bản giả lập trích xuất từ PDF" cố định để yêu cầu tóm tắt |
| 7 | Hội thoại liên tục (Multi-turn) | Lượt 1 đặt một từ khóa đánh dấu, lượt 2 mang theo conversationRef nhận diện được để tiếp tục, kiểm tra phản hồi còn nhớ từ khóa không |
| 8 | Khôi phục hội thoại phía upstream | Tương tự trên, nhưng giữa hai lượt chờ đợi rõ ràng (mặc định 2× `--delay-ms`) và dùng kết nối WebSocket hoàn toàn mới để tiếp nối |
| 9 | Khả năng chịu tải ngữ cảnh dài | Gửi văn bản cố định khoảng 20.000 ký tự, xem upstream có chấp nhận và phản hồi bình thường không |
| 10 | Cách thức chèn Instructions | So sánh giữa trường `passthrough.instructions` và cách chèn tiền tố văn bản, dùng độ dài phản hồi để đánh giá |
| 11 | Xuất JSON có cấu trúc | Đưa ra prompt ràng buộc yêu cầu xuất JSON theo schema cố định, thử parse trực tiếp hoặc parse sau khi tách bỏ văn bản thừa |
| 12 | Hiểu định nghĩa công cụ | Đồng thời mở cả 2 kênh "trường `tools` nguyên bản" và "ràng buộc qua prompt", xem kênh nào được kích hoạt |
| 13 | Gọi công cụ đơn lẻ (Single tool call) | Lấy mẫu lặp lại theo `--repeat`, mỗi lần thử tối đa 2 lần sửa tham số, thống kê 4 chỉ số chất lượng |
| 14 | Gọi công cụ nhiều lượt (Multi-turn tool calls) | Trong cùng một conversationRef, hai lượt liên tiếp đều cần kích hoạt gọi công cụ |
| 15 | Gọi công cụ song song (Parallel tool calls) | Prompt yêu cầu gọi đồng thời 2 công cụ cùng lúc, đếm số lượng cuộc gọi công cụ xuất hiện trong 1 lượt |
| 16 | Tiếp tục tạo nội dung sau khi trả kết quả công cụ | Đóng gói `ToolResultInput` gửi lại, kiểm tra xem có phản hồi tiếp nối không và không kích hoạt lại cùng một lời gọi công cụ |
| 17 | Hủy yêu cầu (Request cancellation) | Ngay sau khi nhận chunk đầu tiên tiến hành `AbortController.abort()` và gửi frame stop, kiểm tra xem dừng có kịp thời không |
| 18 | Mức sử dụng Token (Usage) | Quét đệ quy các frame thô, tìm kiếm các trường có tên khớp với `token` hoặc `usage` |
| 19 | Thông tin trích dẫn và nguồn tham chiếu | Đặt một câu hỏi có thể cần thông tin trên mạng, kiểm tra xem có xuất hiện sự kiện `sourceAttributions` / `citation` không |
| 20 | Lựa chọn tên mô hình | Gửi request kèm `passthrough.model`, xem có bị từ chối không |
| 21 | Thông tin mô hình thực tế do upstream trả về | Yêu cầu mô hình tự giới thiệu tên, đồng thời quét frame thô xem có trường `model` không |
| 22 | Refresh Access Token | Gọi `TokenManager.refresh()`, so sánh thời gian hết hạn trước và sau khi refresh xem có được gia hạn không |
| 23 | Xoay vòng Refresh Token (Rotation) | So sánh xem `refresh_token` trước và sau refresh có thay đổi không (chỉ so sánh bằng nhau hay không, không ghi lại plaintext) |
| 24 | Phân loại lỗi (Error Classification) | Quan sát thụ động: Gửi một request bình thường, ghi nhận phân loại lỗi gặp phải; ma trận lỗi đầy đủ được tổng hợp tự nhiên qua toàn bộ đợt chạy |
| 25 | Hành vi Retry-After và giới hạn tần suất | Quan sát thụ động: Không chủ động tạo mã 429, nếu tự nhiên gặp phải thì ghi nhận số mili-giây hạ nhiệt parse được |
| 26 | Khác biệt năng lực giữa tài khoản/tenant | Bản thân từng tài khoản không tạo thêm request mới, chỉ ghi nhận dấu vân tay; so sánh ngang ở cuối báo cáo khi dùng `--all` |
| 27 | Ràng buộc giữa phiên và tài khoản | Dùng một conversationRef bịa ra không do upstream cấp để tiếp nối, kiểm tra xem có vô tình đọc được nội dung hội thoại khác không |
| 28 | Tiếp nối hội thoại sau khi refresh Token | Tạo hội thoại → Bắt buộc refresh Token → Dùng Token mới để tiếp nối cùng conversationRef đó |
| 29 | Hủy bỏ khi client ngắt kết nối đột ngột | Nhận chunk đầu tiên xong **không gửi** bất kỳ frame stop nào, lập tức ngắt kết nối, quan sát phía client có dọn dẹp sạch sẽ không |

## Tầng Khử Dữ liệu Nhạy cảm (Redaction Layer - `src/evidence.ts`)

Báo cáo chỉ có thể được xuất qua tầng này với các nguyên tắc nghiêm ngặt:

- **Các tên khóa bị cấm** (`access_token`, `refresh_token`, `id_token`, `code`, `code_verifier`, `cookie`, `authorization`, `password`, `client_secret`, `master_key`, không phân biệt hoa thường): Khi phát hiện sẽ bị thay thế toàn bộ thành `<redacted:forbidden-key>`, bất kể giá trị là chuỗi hay đối tượng lồng nhau.
- Mọi giá trị chuỗi khác mặc định bị thay thế thành `<string:độ_dài>` (giữ nguyên tên trường và kiểu dữ liệu), chỉ có các chuỗi văn bản test cố định do caller truyền vào một cách tường minh mới được giữ nguyên bản.
- **Quy tắc phỏng đoán an toàn (Fallback heuristic)**: Dù tên khóa không nhạy cảm, nhưng nếu có cấu trúc dạng JWT (`eyJ...\....\....`), tham số URL dạng `access_token=`, header xác thực `Bearer ...` đều tự động bị coi là "nguy cơ khóa bí mật" và bị khử nhạy cảm.
- Địa chỉ email chỉ giữ dạng mặt nạ (`fo***@example.com`), ID tenant và user chỉ giữ 8 ký tự đầu.
- Tuyến phòng thủ cuối cùng trước khi ghi đĩa (`assertReportClean`): Quét lại toàn bộ văn bản Markdown/JSON hoàn chỉnh sau khi render, nếu phát hiện bất kỳ dấu hiệu nhạy cảm nào sẽ ném lỗi ngoại lệ ngay lập tức và từ chối ghi đĩa.

## Tự kiểm thử (Chỉ kết nối Mock Upstream)

```bash
cd probe
npm run typecheck
npm test
```

Các test case trong `test/` chỉ kết nối vào mock server Sydney WebSocket tại `apps/server/test/helpers/mockSydneyServer.ts`, tuyệt đối không kết nối Microsoft thật, không chứa bất kỳ thông tin đăng nhập, email hay tên miền thật nào.

## Cách sử dụng báo cáo để hiệu chuẩn dự án sau khi chạy

1. Mở `probe-<thời gian>.md`, đọc trước **Kết luận tổng thể**: "Có thể tiến hành phát triển hoàn chỉnh" hay "Cần thu hẹp phạm vi phát hành ban đầu".
2. Xem mục "Quan sát thấy nhưng chưa được mô hình hóa trong `codecV1.ts`" — đây là các trường frame thực tế xuất hiện nhưng `apps/server/src/adapter/codecV1.ts` hiện chưa đọc; bổ sung logic ánh xạ tương ứng vào `mapMessageToEvents`.
3. Đồng bộ giá trị gợi nghị của `TOOLS_MODE` vào biến môi trường `TOOLS_MODE` của hệ thống (`native`/`prompt`/`auto`).
4. Đồng bộ khuyến nghị về `UPSTREAM_IMAGE_INPUT` vào biến môi trường cùng tên; chỉ bật khi báo cáo ghi nhận việc gửi ảnh thực sự có tác dụng, mặc định tiếp tục giữ `false`.
5. Thông số `Retry-After` quan sát được dùng để hiệu chuẩn thời gian hạ nhiệt mặc định của bộ điều phối scheduler.
6. Nếu gọi công cụ chỉ có thể mô phỏng qua prompt và chưa đạt 4 chỉ số ngưỡng, phiên bản phát hành cần thu hẹp phạm vi mặc định của tool calls theo yêu cầu (không bật mặc định, đánh dấu trung thực là `unstable` trong ma trận tương thích).
7. Nếu chạy `--all` cho nhiều tài khoản, đối chiếu bảng "Sự khác biệt năng lực giữa các tài khoản / tenant" để xác định tính năng nào ổn định xuyên suốt các loại tài khoản.

## Nhắc nhở về các ràng buộc cứng khi chỉnh sửa Probe

- Không sửa đổi `apps/server/**`, `apps/web/**`, `Dockerfile`, `.github/**`, và `package.json` gốc.
- Kiểm thử tự động chỉ được kết nối mock server, tuyệt đối không kết nối Microsoft thật; trong test không xuất hiện thông tin đăng nhập/email/domain thật.
- Token chỉ tồn tại trong bộ nhớ RAM để cấu hình kết nối WebSocket, tuyệt đối không được ghi ra bất kỳ tệp, nhật ký hay báo cáo nào.
