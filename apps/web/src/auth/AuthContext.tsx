import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { setAuthToken, setUnauthorizedHandler } from '../api/http';

/**
 * Token phiên làm việc chỉ lưu ở 2 nơi: React state (trong bộ nhớ) và sessionStorage (dùng để khôi phục khi tải lại trang).
 * Tuyệt đối không ghi vào localStorage, tuyệt đối không xuất hiện trong bất kỳ log/console nào.
 */

const SESSION_STORAGE_KEY = 'm365codex.admin.session';

interface StoredSession {
  token: string;
  expires_at: number;
}

interface AuthContextValue {
  token: string | null;
  expiresAt: number | null;
  status: 'checking' | 'authenticated' | 'anonymous';
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (typeof parsed.token !== 'string' || typeof parsed.expires_at !== 'number') return null;
    if (parsed.expires_at <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession | null): void {
  if (session === null) {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } else {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [status, setStatus] = useState<'checking' | 'authenticated' | 'anonymous'>('checking');

  const clearSession = useCallback(() => {
    setToken(null);
    setExpiresAt(null);
    setAuthToken(null);
    writeStoredSession(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // Lần tải đầu tiên: Thử khôi phục phiên từ sessionStorage và xác thực lại với máy chủ xem còn hiệu lực không.
  useEffect(() => {
    const stored = readStoredSession();
    if (stored === null) {
      setStatus('anonymous');
      return;
    }
    setAuthToken(stored.token);
    api
      .getSession()
      .then(() => {
        setToken(stored.token);
        setExpiresAt(stored.expires_at);
        setStatus('authenticated');
      })
      .catch(() => {
        clearSession();
      });
    // clearSession được tạo bởi useCallback([]), tham chiếu ổn định, việc đưa vào dependency sẽ không làm effect này chạy lại;
    // nhưng nó thực sự được sử dụng trong effect nên liệt kê đầy đủ.
  }, [clearSession]);

  const login = useCallback(async (password: string) => {
    const res = await api.login(password);
    setAuthToken(res.token);
    writeStoredSession({ token: res.token, expires_at: res.expires_at });
    setToken(res.token);
    setExpiresAt(res.expires_at);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => {
      /* Đăng xuất thất bại cũng phải xóa trạng thái cục bộ, tránh để người dùng bị kẹt ở trạng thái đã đăng nhập */
    });
    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ token, expiresAt, status, login, logout }),
    [token, expiresAt, status, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth phải được sử dụng bên trong AuthProvider');
  return ctx;
}
