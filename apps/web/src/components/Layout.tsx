import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ThemeToggle } from './ThemeToggle';
import {
  IconAccounts,
  IconAddAccount,
  IconApiKey,
  IconBackup,
  IconCapabilities,
  IconCodex,
  IconFiles,
  IconLogout,
  IconLogs,
  IconOAuth,
  IconOverview,
  IconProxies,
  IconRequests,
  IconScheduler,
  IconSettings,
} from './icons';

const NAV = [
  {
    section: 'Giám sát & Quản lý',
    items: [
      { to: '/overview', label: 'Tổng quan', icon: IconOverview },
      { to: '/accounts', label: 'Tài khoản Microsoft', icon: IconAccounts },
      { to: '/accounts/add', label: 'Thêm tài khoản', icon: IconAddAccount },
      { to: '/requests', label: 'Nhật ký yêu cầu', icon: IconRequests },
      { to: '/api-keys', label: 'API Key', icon: IconApiKey },
      { to: '/capabilities', label: 'Mô hình & Năng lực', icon: IconCapabilities },
      { to: '/files', label: 'Quản lý tệp', icon: IconFiles },
      { to: '/proxies', label: 'Nhóm Proxy', icon: IconProxies },
    ],
  },
  {
    section: 'Cấu hình',
    items: [
      { to: '/settings/oauth', label: 'OAuth', icon: IconOAuth },
      { to: '/settings/scheduler', label: 'Lập lịch điều phối', icon: IconScheduler },
      { to: '/settings/logging', label: 'Nhật ký log', icon: IconLogs },
      { to: '/settings/system', label: 'Cài đặt hệ thống', icon: IconSettings },
      { to: '/codex-config', label: 'Cấu hình Codex', icon: IconCodex },
    ],
  },
  {
    section: 'Vận hành & Bảo trì',
    items: [{ to: '/backup', label: 'Sao lưu & Phục hồi', icon: IconBackup }],
  },
];

export function Layout({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  const { logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          M365-Codex
        </div>
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="nav-section-label">{group.section}</div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <item.icon />
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </aside>
      <main className="main">
        <div className="topbar">
          <div>
            <h1 className="page-title">{title}</h1>
            {subtitle !== undefined && <div className="page-subtitle">{subtitle}</div>}
          </div>
          <div className="flex gap-12" style={{ alignItems: 'center' }}>
            <ThemeToggle />
            <button type="button" className="btn btn-sm" onClick={logout}>
              <IconLogout />
              Đăng xuất
            </button>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
