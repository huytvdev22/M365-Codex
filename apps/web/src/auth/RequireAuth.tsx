import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from './AuthContext';

/** Chưa đăng nhập (hoặc phiên hết hạn/bị mã 401 xóa) đều điều hướng về trang đăng nhập; sau khi đăng nhập đưa trở lại đường dẫn trước đó. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'checking') {
    return (
      <div className="state-block" role="status">
        <span className="spinner" aria-hidden="true" />
        <div style={{ marginTop: 10 }}>Đang kiểm tra trạng thái đăng nhập…</div>
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
