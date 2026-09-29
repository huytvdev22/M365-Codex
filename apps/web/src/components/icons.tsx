/**
 * Tập hợp icon SVG nội tuyến — không phụ thuộc gói icon ngoài, phong cách tối giản (stroke 1.6).
 */
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(children: ReactNode, props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconOverview = (p: IconProps) =>
  base(
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>,
    p,
  );

export const IconAccounts = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M4.5 20c1.4-4 4-5.6 7.5-5.6s6.1 1.6 7.5 5.6" />
    </>,
    p,
  );

export const IconAddAccount = (p: IconProps) =>
  base(
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.8 20c1.2-3.6 3.5-5 6.2-5" />
      <path d="M17 8v6M14 11h6" />
    </>,
    p,
  );

export const IconRequests = (p: IconProps) =>
  base(
    <>
      <path d="M4 5h16M4 12h16M4 19h10" />
    </>,
    p,
  );

export const IconApiKey = (p: IconProps) =>
  base(
    <>
      <circle cx="8" cy="15" r="3.2" />
      <path d="M10.3 12.7 18 5l2 2-1.6 1.6M16.5 8.5l2 2" />
    </>,
    p,
  );

export const IconCapabilities = (p: IconProps) =>
  base(
    <>
      <path d="M12 3 4 7v6c0 4.4 3.4 7.3 8 8 4.6-.7 8-3.6 8-8V7Z" />
      <path d="m9 12 2 2 4-4" />
    </>,
    p,
  );

export const IconFiles = (p: IconProps) =>
  base(
    <>
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v4h4" />
    </>,
    p,
  );

export const IconProxies = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.4 2.5 3.6 5.6 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.6-3.6-9S9.6 5.5 12 3Z" />
    </>,
    p,
  );

export const IconOAuth = (p: IconProps) =>
  base(
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>,
    p,
  );

export const IconScheduler = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>,
    p,
  );

export const IconLogs = (p: IconProps) =>
  base(
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" />
      <path d="M9 8h6M9 12h6" />
    </>,
    p,
  );

export const IconBackup = (p: IconProps) =>
  base(
    <>
      <path d="M12 3v12" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 19h16" />
    </>,
    p,
  );

export const IconSettings = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.4.6a7.7 7.7 0 0 0-1.7-1L15 3h-4l-.3 2.7a7.7 7.7 0 0 0-1.7 1l-2.4-.6-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.4-.6a7.7 7.7 0 0 0 1.7 1L11 21h4l.3-2.7a7.7 7.7 0 0 0 1.7-1l2.4.6 2-3.4Z" />
    </>,
    p,
  );

export const IconCodex = (p: IconProps) =>
  base(
    <>
      <path d="m9 9-4 4 4 4M15 9l4 4-4 4M13 5l-2 14" />
    </>,
    p,
  );

export const IconCopy = (p: IconProps) =>
  base(
    <>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </>,
    p,
  );

export const IconCheck = (p: IconProps) => base(<path d="M4 12.5 9 17l11-11" />, p);

export const IconLogout = (p: IconProps) =>
  base(
    <>
      <path d="M9 4H5v16h4" />
      <path d="M15 16l4-4-4-4M19 12H9" />
    </>,
    p,
  );

export const IconSun = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </>,
    p,
  );

export const IconMoon = (p: IconProps) => base(<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />, p);
