/**
 * Định nghĩa migration cơ sở dữ liệu.
 *
 * Migration chỉ thêm chứ không sửa: migration đã phát hành không được sửa đổi tại chỗ mà chỉ thêm phiên bản mới.
 * Mỗi milestone bổ sung các bảng cần thiết cho mình, tránh tạo trước các bảng rỗng không có người dùng.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const M001_CORE = `
-- Bảng cài đặt key-value chung
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- API Key đối ngoại. CSDL chỉ lưu hash và prefix index, không lưu plain text.
CREATE TABLE api_keys (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  prefix            TEXT NOT NULL,
  salt              TEXT NOT NULL,
  hash              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  revoked_at        INTEGER,
  starts_at         INTEGER,
  expires_at        INTEGER,
  rpm_limit         INTEGER,
  daily_limit       INTEGER,
  max_concurrency   INTEGER,
  allowed_endpoints TEXT,
  allowed_models    TEXT,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,
  last_used_ip      TEXT
);
CREATE INDEX idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX idx_api_keys_enabled ON api_keys (enabled);

-- Phiên quản trị. Chỉ lưu hash của token phiên.
CREATE TABLE admin_sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  client_ip    TEXT
);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions (expires_at);

-- Nhật ký kiểm toán (audit log): Lưu dấu vết thao tác nhạy cảm phía quản trị, không ghi lại thông tin xác thực.
CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  client_ip  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);
`;

const M002_ACCOUNTS = `
-- Tài khoản Microsoft. Cùng cặp (tenant, object) chỉ lưu 1 bản ghi, ủy quyền lại sẽ cập nhật thay vì thêm mới.
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  tid           TEXT NOT NULL,
  oid           TEXT NOT NULL,
  email         TEXT,
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'probing',
  proxy_node_id TEXT,
  source        TEXT NOT NULL DEFAULT 'oauth',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (tid, oid)
);
CREATE INDEX idx_accounts_status ON accounts (status);

-- Token tài khoản. Cả access/refresh đều được mã hóa bằng AES-256-GCM, mỗi trường có nonce độc lập.
CREATE TABLE account_tokens (
  account_id        TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  access_token_enc  BLOB,
  access_nonce      BLOB,
  refresh_token_enc BLOB,
  refresh_nonce     BLOB,
  key_version       INTEGER NOT NULL,
  expires_at        INTEGER,
  rotated_at        INTEGER
);

-- Độ khỏe tài khoản. Bộ điều phối dựa vào đây để làm nguội và lựa chọn tài khoản tối ưu, M3 tiếp tục mở rộng.
CREATE TABLE account_health (
  account_id           TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  last_ok_at           INTEGER,
  last_error_at        INTEGER,
  last_error_type      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until       INTEGER,
  updated_at           INTEGER NOT NULL
);

-- Phiên ủy quyền PKCE. code_verifier là dữ liệu nhạy cảm, cũng được mã hóa lưu trữ.
-- consumed_at đảm bảo mã ủy quyền chỉ được sử dụng một lần duy nhất.
CREATE TABLE oauth_sessions (
  state               TEXT PRIMARY KEY,
  code_verifier_enc   BLOB NOT NULL,
  code_verifier_nonce BLOB NOT NULL,
  key_version         INTEGER NOT NULL,
  redirect_uri        TEXT NOT NULL,
  scopes              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  consumed_at         INTEGER
);
CREATE INDEX idx_oauth_sessions_expires_at ON oauth_sessions (expires_at);
`;

const M003_RESPONSES = `
-- Bản ghi yêu cầu Responses.
-- Mỗi yêu cầu đều ghi lại 4 nhóm thông tin model requested_* và upstream/reported_* (tương ứng §4.2):
--   requested_model / requested_reasoning_effort: Giá trị gốc của client request
--   upstream_model_parameter: Giá trị thực tế chuyển tiếp tới upstream
--   reported_upstream_model: Model do upstream tự báo cáo (có thể khác với request)
-- body lưu JSON Response sau khi hoàn tất, phục vụ trả về cho GET /v1/responses/:id.
CREATE TABLE responses (
  id                         TEXT PRIMARY KEY,
  api_key_id                 TEXT REFERENCES api_keys (id),
  account_id                 TEXT REFERENCES accounts (id),
  status                     TEXT NOT NULL,
  requested_model            TEXT,
  requested_reasoning_effort TEXT,
  upstream_model_parameter   TEXT,
  reported_upstream_model    TEXT,
  previous_response_id       TEXT,
  idempotency_key            TEXT,
  body                       TEXT,
  error_message              TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  UNIQUE (api_key_id, idempotency_key)
);
CREATE INDEX idx_responses_api_key ON responses (api_key_id);
CREATE INDEX idx_responses_status ON responses (status);

-- Ràng buộc dính giữa Response ↔ Tài khoản ↔ Phiên upstream (tương ứng §5).
-- previous_response_id khi tiếp tục phiên dựa vào đây để tái sử dụng cùng tài khoản và phiên upstream.
CREATE TABLE conversation_bindings (
  response_id               TEXT PRIMARY KEY REFERENCES responses (id) ON DELETE CASCADE,
  account_id                TEXT REFERENCES accounts (id),
  upstream_conversation_ref TEXT,
  created_at                INTEGER NOT NULL
);
`;

const M004_TOOL_CALLS = `
-- Bản ghi gọi công cụ (tương ứng §5, §M5).
-- UNIQUE (response_id, call_id) + status đảm bảo cùng một lệnh gọi công cụ không bị thực thi lặp do reconnect/submit lại.
-- side_effect đánh dấu công cụ có thể tạo tác dụng phụ hay không; giai đoạn tác dụng phụ cấm tự động replay qua tài khoản khác.
CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES responses (id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  arguments   TEXT,
  status      TEXT NOT NULL DEFAULT 'emitted',
  side_effect INTEGER NOT NULL DEFAULT 0,
  output      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (response_id, call_id)
);
CREATE INDEX idx_tool_calls_call_id ON tool_calls (call_id);

-- Đếm vòng lặp agent tích lũy dọc theo chuỗi đối thoại (tương ứng §7.4 "vòng lặp công cụ tối đa / tổng số lệnh gọi tích lũy tối đa").
-- Đặt trên dòng response để lấy bộ đếm lượt trước với độ phức tạp O(1), không phải duyệt ngược cả chuỗi previous_response_id.
ALTER TABLE responses ADD COLUMN tool_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE responses ADD COLUMN tool_calls_total INTEGER NOT NULL DEFAULT 0;
`;

const M005_FILES_UPLOADS = `
-- Metadata tệp (tương ứng §11, §M6). Trên ổ đĩa chỉ tạo thư mục theo file-id để lưu nội dung,
-- tên tệp (filename) chỉ lưu trong CSDL, tuyệt đối không ghép trực tiếp vào đường dẫn ổ đĩa.
-- status: processed (đã trích xuất hoặc xác định rõ không thể trích xuất) / error (trích xuất thất bại).
-- Khi extracted_text rỗng và status=processed biểu thị "đã nhận diện nhưng chủ động không trích xuất"
-- (như file nhị phân không nhận diện, hình ảnh), extraction_note giải thích lý do, không phải lỗi.
CREATE TABLE files (
  id               TEXT PRIMARY KEY,
  api_key_id       TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  filename         TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'processed',
  extracted_text   TEXT,
  extraction_note  TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  deleted_at       INTEGER
);
CREATE INDEX idx_files_api_key ON files (api_key_id);
CREATE INDEX idx_files_expires_at ON files (expires_at);

-- Tải lên phân mảnh (Uploads API). Luồng trạng thái: pending -> completed / cancelled / expired.
-- Sau khi hoàn tất file_id trỏ tới dòng files được lắp ráp; khi hủy hoặc hết hạn thì dọn dẹp các mảnh đã nhận trên đĩa.
CREATE TABLE uploads (
  id          TEXT PRIMARY KEY,
  api_key_id  TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  file_id     TEXT REFERENCES files (id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_uploads_api_key ON uploads (api_key_id);
CREATE INDEX idx_uploads_status_expires ON uploads (status, expires_at);

-- Mảnh phân đoạn: Mỗi part lưu thành một file đĩa độc lập (<DATA_DIR>/files/uploads/<upload-id>/<part-id>),
-- khi complete sẽ ghép theo thứ tự chỉ định trong part_ids. part_number chỉ dùng khử trùng lặp và theo dõi trong cùng upload.
CREATE TABLE upload_parts (
  id           TEXT PRIMARY KEY,
  upload_id    TEXT NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
  part_number  INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (upload_id, part_number)
);
`;

const M006_IDEMPOTENCY = `
-- Tính bất biến/idempotency của yêu cầu (tương ứng §18).
-- Khóa chính là bộ ba (key, api_key_id, endpoint): Phạm vi khóa idempotency giới hạn trong từng API Key
-- và từng endpoint, chuỗi giống nhau giữa các Key khác nhau hoàn toàn độc lập.
-- request_fingerprint lưu hash ổn định của request body: Cùng key mà gửi body khác nhau là client dùng sai key,
-- bắt buộc phải báo lỗi, không được xem hai request khác nhau là một.
CREATE TABLE idempotency_keys (
  key                 TEXT NOT NULL,
  api_key_id          TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  endpoint            TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'in_progress',
  response_id         TEXT,
  status_code         INTEGER,
  body                TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (key, api_key_id, endpoint)
);
CREATE INDEX idx_idempotency_created_at ON idempotency_keys (created_at);
`;

const M007_PROXY_NODES = `
-- Nhóm proxy outbound (tương ứng §13.1, §M7).
-- url chứa tài khoản mật khẩu thuộc dữ liệu nhạy cảm, mã hóa AES-256-GCM cùng chuẩn với Token;
-- Giao diện danh sách chỉ trả về url_masked đã che mặt nạ (xem repo/proxyNodes.ts), plain text không bao giờ ra khỏi gateway.
CREATE TABLE proxy_nodes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url_enc        BLOB NOT NULL,
  url_nonce      BLOB NOT NULL,
  key_version    INTEGER NOT NULL,
  protocol       TEXT NOT NULL,
  weight         INTEGER NOT NULL DEFAULT 1,
  priority       INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'unknown',
  latency_ms     INTEGER,
  last_check_at  INTEGER,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_proxy_nodes_enabled ON proxy_nodes (enabled);
`;

const M008_RESPONSES_DROP_IDEMPOTENCY_UNIQUE = `
-- Nới lỏng ràng buộc duy nhất của bảng responses (tương ứng tái cấu trúc idempotency §18).
-- M003 khi tạo bảng đã đặt trực tiếp UNIQUE (api_key_id, idempotency_key) trên bảng responses,
-- lúc đó là ràng buộc giữ chỗ trước khi "ngữ nghĩa hoàn chỉnh ở M7"; hiện nay bảo đảm idempotency đầy đủ đã thu về bảng
-- idempotency_keys độc lập (begin/complete/release, phạm vi kèm endpoint; request dạng stream
-- khi thực thi xong sẽ release key này, cho phép cùng key thực thi lại sau). Ràng buộc cấp bảng này ngược lại sẽ xung đột
-- với việc "thực thi lại sau khi giải phóng cùng key" — khi INSERT lần thứ hai một dòng response mới sẽ đụng ràng buộc cũ báo lỗi.
-- Do đó ở đây dựng lại bảng để xóa ràng buộc này: Cột idempotency_key tiếp tục giữ lại để kiểm toán/truy vết,
-- không còn gánh vác trách nhiệm duy nhất; SQLite không hỗ trợ DROP CONSTRAINT, bắt buộc phải dựng lại toàn bảng.
--
-- Cạm bẫy: DROP TABLE của SQLite tương đương DELETE từng dòng rồi mới xóa định nghĩa bảng, khi PRAGMA
-- foreign_keys=ON sẽ kích hoạt hành động ON DELETE của khóa ngoại trên từng dòng — tức DROP TABLE
-- responses sẽ xóa theo tầng làm rỗng toàn bộ bản ghi trong tool_calls và conversation_bindings tham chiếu tới các dòng này!
-- Vì vậy trước tiên chụp snapshot dữ liệu nguyên bản của hai bảng này ra, sau khi dựng lại responses thì chèn lại.
CREATE TABLE _tool_calls_backup_v8 AS SELECT * FROM tool_calls;
CREATE TABLE _conversation_bindings_backup_v8 AS SELECT * FROM conversation_bindings;

CREATE TABLE responses_v8 (
  id                         TEXT PRIMARY KEY,
  api_key_id                 TEXT REFERENCES api_keys (id),
  account_id                 TEXT REFERENCES accounts (id),
  status                     TEXT NOT NULL,
  requested_model            TEXT,
  requested_reasoning_effort TEXT,
  upstream_model_parameter   TEXT,
  reported_upstream_model    TEXT,
  previous_response_id       TEXT,
  idempotency_key            TEXT,
  body                       TEXT,
  error_message              TEXT,
  tool_round                 INTEGER NOT NULL DEFAULT 0,
  tool_calls_total           INTEGER NOT NULL DEFAULT 0,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);
INSERT INTO responses_v8 (
  id, api_key_id, account_id, status, requested_model, requested_reasoning_effort,
  upstream_model_parameter, reported_upstream_model, previous_response_id, idempotency_key,
  body, error_message, tool_round, tool_calls_total, created_at, updated_at
)
SELECT
  id, api_key_id, account_id, status, requested_model, requested_reasoning_effort,
  upstream_model_parameter, reported_upstream_model, previous_response_id, idempotency_key,
  body, error_message, tool_round, tool_calls_total, created_at, updated_at
FROM responses;
DROP TABLE responses;
ALTER TABLE responses_v8 RENAME TO responses;
CREATE INDEX idx_responses_api_key ON responses (api_key_id);
CREATE INDEX idx_responses_status ON responses (status);
CREATE INDEX idx_responses_idempotency_lookup ON responses (api_key_id, idempotency_key);

-- responses đã được phục hồi bằng bảng mới, chèn lại dữ liệu các bảng con bị xóa dây chuyền
DELETE FROM tool_calls;
INSERT INTO tool_calls SELECT * FROM _tool_calls_backup_v8;
DELETE FROM conversation_bindings;
INSERT INTO conversation_bindings SELECT * FROM _conversation_bindings_backup_v8;

DROP TABLE _tool_calls_backup_v8;
DROP TABLE _conversation_bindings_backup_v8;
`;

const M009_API_KEYS_EXTRA_FIELDS = `
-- Bổ sung 4 trường API Key được liệt kê trong kế hoạch §10.1:
-- Ghi chú (note, chỉ hiển thị), số lần yêu cầu tích lũy (request_count, hiển thị lượng dùng trên trang quản trị),
-- giới hạn số lần gọi công cụ siết chặt theo Key (max_tool_calls) và giới hạn kích thước tệp/mảnh upload đơn lẻ
-- (max_file_bytes). Cả hai trường sau đều mang ngữ nghĩa "chỉ có thể chặt chẽ hơn, không vượt quá trần toàn cục"
-- (nhất quán với rpm_limit/daily_limit/max_concurrency sẵn có), logic áp dụng lần lượt tích hợp vào
-- bộ đếm vòng công cụ của responses/service.ts và kiểm tra kích thước của files/service.ts,
-- lấy min(cài đặt của Key, cấu hình toàn cục).
--
-- Thời điểm cập nhật request_count thực hiện cùng lúc với last_used_at (touch() trong repo/apiKeys.ts),
-- không ghi thêm một lần riêng lẻ trên đường dẫn xác thực nóng.
ALTER TABLE api_keys ADD COLUMN note TEXT;
ALTER TABLE api_keys ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN max_tool_calls INTEGER;
ALTER TABLE api_keys ADD COLUMN max_file_bytes INTEGER;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core_settings_apikeys_admin_audit', sql: M001_CORE },
  { version: 2, name: 'accounts_tokens_health_oauth_sessions', sql: M002_ACCOUNTS },
  { version: 3, name: 'responses_conversation_bindings', sql: M003_RESPONSES },
  { version: 4, name: 'tool_calls', sql: M004_TOOL_CALLS },
  { version: 5, name: 'files_uploads', sql: M005_FILES_UPLOADS },
  { version: 6, name: 'idempotency_keys', sql: M006_IDEMPOTENCY },
  { version: 7, name: 'proxy_nodes', sql: M007_PROXY_NODES },
  { version: 8, name: 'responses_drop_idempotency_unique', sql: M008_RESPONSES_DROP_IDEMPOTENCY_UNIQUE },
  { version: 9, name: 'api_keys_note_usage_tool_file_limits', sql: M009_API_KEYS_EXTRA_FIELDS },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
