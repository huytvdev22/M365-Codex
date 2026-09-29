import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../components/ErrorBanner';
import { ThemeToggle } from '../components/ThemeToggle';

export function LoginPage() {
  const { login, status } = useAuth();
  const location = useLocation();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from ?? '/overview';
    return <Navigate to={from} replace />;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    // Đăng nhập thành công không cần navigate thủ công tại đây: login() bên trong sẽ chuyển status sang 'authenticated',
    // nhánh `status === 'authenticated'` ở đầu component sẽ tự động chuyển hướng qua <Navigate> trong lần render kế tiếp.
    login(password)
      .catch((err: unknown) => setError(err))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="flex-between" style={{ marginBottom: 20 }}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            M365-Codex
          </div>
          <ThemeToggle />
        </div>
        <div className="card">
          <h1 className="page-title" style={{ marginBottom: 4 }}>
            Đăng nhập Quản trị viên
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 20 }}>
            Đăng nhập bằng <code>M365_CODEX_ADMIN_PASSWORD</code>, hoàn toàn tách biệt với API Key đối ngoại.
          </p>
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="admin-password">Mật khẩu quản trị viên</label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
              />
            </div>
            {error !== null && (
              <div style={{ marginBottom: 14 }}>
                <ErrorBanner error={error} />
              </div>
            )}
            <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={submitting}>
              {submitting ? 'Đang đăng nhập…' : 'Đăng nhập'}
            </button>
          </form>
        </div>
        <p className="text-faint" style={{ marginTop: 14, fontSize: 12 }}>
          Token chỉ được lưu trong bộ nhớ và session storage của tab này, cần đăng nhập lại sau khi đóng tab.
        </p>
      </div>
    </div>
  );
}
