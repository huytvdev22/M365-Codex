import { Buffer } from 'node:buffer';
import type { Logger } from 'pino';
import { openDatabase, runMigrations, type Database } from '../../apps/server/dist/db/index.js';
import { Cryptor } from '../../apps/server/dist/crypto/index.js';
import { AccountRepository } from '../../apps/server/dist/repo/accounts.js';
import { HttpOAuthClient } from '../../apps/server/dist/oauth/client.js';
import { TokenManager } from '../../apps/server/dist/oauth/tokenManager.js';
import {
  DEFAULT_OAUTH_AUTHORIZE_URL,
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_REDIRECT_URI,
  DEFAULT_OAUTH_SCOPES,
  DEFAULT_OAUTH_TOKEN_URL,
  type OAuthConfig,
} from '../../apps/server/dist/config/index.js';

/**
 * Nguồn tài khoản: Cơ sở dữ liệu SQLite của chính gateway (tương ứng kế hoạch triển khai §3.2 "Probe đọc Token từ tài khoản ủy quyền hiện có").
 * Tài khoản chỉ có thể được thêm qua quy trình ủy quyền PKCE, probe không thực hiện bất kỳ đăng nhập nào, chỉ đọc tài khoản hiện có.
 *
 * Quy tắc sắt: Token sau khi giải mã chỉ truyền trong bộ nhớ cho hàm tạo URL WebSocket, bất kỳ tầng nào của probe
 * đều không được ghi nó vào file, log hay bất kỳ nơi nào ngoài giá trị trả về.
 */

export interface OpenAccountDbOptions {
  dbPath: string;
  masterKeyBase64: string;
  masterKeyVersion: number;
  oauth?: Partial<OAuthConfig>;
  logger: Logger;
}

export interface AccountSource {
  db: Database;
  accounts: AccountRepository;
  tokenManager: TokenManager;
  oauthClient: HttpOAuthClient;
  close: () => void;
}

function parseMasterKey(raw: string): Buffer {
  const decoded = Buffer.from(raw.trim(), 'base64');
  if (decoded.byteLength !== 32) {
    throw new Error(`M365_CODEX_MASTER_KEY 解码后为 ${decoded.byteLength} 字节，要求正好 32 字节`);
  }
  return decoded;
}

/** Mở database tài khoản và chuẩn bị các component cần thiết để đọc/refresh Token. Không thực hiện bất kỳ thay đổi nào ngoài schema. */
export function openAccountSource(options: OpenAccountDbOptions): AccountSource {
  const masterKey = parseMasterKey(options.masterKeyBase64);
  const db = openDatabase(options.dbPath);
  runMigrations(db);

  const cryptor = new Cryptor(masterKey, options.masterKeyVersion);
  const accounts = new AccountRepository(db, cryptor);

  const oauthConfig: OAuthConfig = {
    clientId: options.oauth?.clientId ?? DEFAULT_OAUTH_CLIENT_ID,
    redirectUri: options.oauth?.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI,
    authorizeUrl: options.oauth?.authorizeUrl ?? DEFAULT_OAUTH_AUTHORIZE_URL,
    tokenUrl: options.oauth?.tokenUrl ?? DEFAULT_OAUTH_TOKEN_URL,
    scopes: options.oauth?.scopes ?? DEFAULT_OAUTH_SCOPES,
  };
  const oauthClient = new HttpOAuthClient({ config: oauthConfig });
  const tokenManager = new TokenManager({ accounts, client: oauthClient, logger: options.logger });

  return {
    db,
    accounts,
    tokenManager,
    oauthClient,
    close: () => db.close(),
  };
}

