import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, type AuthorizeUrlResponse, type OAuthCallbackResult } from '../api';
import { CopyButton } from '../components/CopyButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';
import { formatDateTime } from '../util/format';

/**
 * Thêm tài khoản theo phương thức duy nhất: Quy trình ủy quyền PKCE của chính gateway này.
 * Vì callback kết thúc tại trang của Microsoft, dịch vụ này không cần IP công khai và không cần mở endpoint callback —
 * người dùng sau khi đăng nhập xong trên trình duyệt chỉ cần dán URL đầy đủ từ thanh địa chỉ vào đây.
 */
export function AddAccountPage() {
  const [session, setSession] = useState<AuthorizeUrlResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  const [callbackUrl, setCallbackUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [result, setResult] = useState<OAuthCallbackResult | null>(null);

  const handleCreate = () => {
    setCreating(true);
    setCreateError(null);
    api
      .createAuthorizeUrl()
      .then((res) => setSession(res))
      .catch((err: unknown) => setCreateError(err))
      .finally(() => setCreating(false));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    api
      .submitOAuthCallback(callbackUrl.trim())
      .then((res) => {
        setResult(res);
        setCallbackUrl('');
      })
      .catch((err: unknown) => setSubmitError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <Layout title="Thêm tài khoản" subtitle="Thêm tài khoản Microsoft 365 Copilot thông qua quy trình ủy quyền PKCE">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Bước 1: Tạo liên kết ủy quyền</h2>
        <p className="text-muted">
          Bấm tạo liên kết và mở trong tab mới, đăng nhập bằng tài khoản có quyền Copilot. Sau khi đăng nhập, Microsoft sẽ chuyển hướng đến trang thông báo
          <code> nativeclient </code>
          của họ — điều này hoàn toàn bình thường, hãy sao chép toàn bộ đường dẫn URL trên thanh địa chỉ đó để dùng cho bước tiếp theo.
        </p>
        <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
          {creating ? 'Đang tạo…' : 'Tạo liên kết ủy quyền'}
        </button>
        {createError !== null && (
          <div style={{ marginTop: 12 }}>
            <ErrorBanner error={createError} />
          </div>
        )}
        {session !== null && (
          <div style={{ marginTop: 14 }}>
            <div className="mono-copy" style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>
              <a href={session.authorize_url} target="_blank" rel="noreferrer">
                {session.authorize_url}
              </a>
            </div>
            <div className="flex gap-8" style={{ marginTop: 8 }}>
              <CopyButton value={session.authorize_url} label="Sao chép liên kết" />
              <span className="text-faint" style={{ alignSelf: 'center' }}>
                Phiên hết hạn lúc {formatDateTime(session.expires_at)}, cần tạo lại nếu hết hạn
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Bước 2: Gửi URL chuyển hướng (Callback)</h2>
        <p className="text-muted">
          Dán toàn bộ URL đã sao chép từ thanh địa chỉ trình duyệt vào đây. Mã ủy quyền chỉ có thể sử dụng một lần, có thể ủy quyền song song cho nhiều tài khoản.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="callback-url">Địa chỉ URL chuyển hướng</label>
            <input
              id="callback-url"
              type="text"
              placeholder="https://login.microsoftonline.com/common/oauth2/nativeclient?code=…&state=…"
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              required
            />
          </div>
          {submitError !== null && (
            <div style={{ marginBottom: 12 }}>
              <ErrorBanner error={submitError} />
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting || callbackUrl.trim().length === 0}>
            {submitting ? 'Đang gửi…' : 'Hoàn tất ủy quyền'}
          </button>
        </form>
        {result !== null && (
          <div className="error-banner" style={{ marginTop: 14, borderColor: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 10%, transparent)' }}>
            <div className="error-title" style={{ color: 'var(--ok)' }}>
              {result.existing ? 'Tài khoản đã được ủy quyền lại' : 'Tài khoản đã được thêm thành công'}
            </div>
            <div>
              {result.account.display_name ?? result.account.email ?? result.account.id} (Trạng thái:{' '}
              {result.account.status})
            </div>
            <div style={{ marginTop: 10 }}>
              <Link to="/accounts" className="btn btn-sm">
                Đến danh sách tài khoản
              </Link>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
