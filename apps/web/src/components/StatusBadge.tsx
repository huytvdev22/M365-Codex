/** Ánh xạ các trạng thái → Nhãn tiếng Việt + Màu sắc, quản lý tập trung một nơi. */

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

function Badge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

const ACCOUNT_STATUS_MAP: Record<string, { label: string; tone: Tone }> = {
  probing: { label: 'Đang kiểm tra', tone: 'info' },
  online: { label: 'Trực tuyến', tone: 'ok' },
  busy: { label: 'Đang bận', tone: 'info' },
  cooldown: { label: 'Đang làm nguội', tone: 'warn' },
  reauth_required: { label: 'Cần ủy quyền lại', tone: 'danger' },
  disabled: { label: 'Đã tắt', tone: 'neutral' },
  unsupported: { label: 'Không đủ năng lực', tone: 'neutral' },
  error: { label: 'Lỗi', tone: 'danger' },
};

export function AccountStatusBadge({ status }: { status: string }) {
  const entry = ACCOUNT_STATUS_MAP[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={entry.tone} label={entry.label} />;
}

const SYSTEM_STATUS_MAP: Record<string, { label: string; tone: Tone }> = {
  normal: { label: 'Bình thường', tone: 'ok' },
  degraded: { label: 'Giảm cấp', tone: 'warn' },
  maintenance: { label: 'Đang bảo trì', tone: 'info' },
  upstream_unavailable: { label: 'Upstream không khả dụng', tone: 'danger' },
  migration_failed: { label: 'Migration thất bại', tone: 'danger' },
};

export function SystemStatusBadge({ status }: { status: string }) {
  const entry = SYSTEM_STATUS_MAP[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={entry.tone} label={entry.label} />;
}

const RESPONSE_STATUS_MAP: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Đang xếp hàng', tone: 'neutral' },
  in_progress: { label: 'Đang xử lý', tone: 'info' },
  completed: { label: 'Đã hoàn tất', tone: 'ok' },
  incomplete: { label: 'Chưa hoàn tất', tone: 'warn' },
  failed: { label: 'Thất bại', tone: 'danger' },
  cancelled: { label: 'Đã hủy', tone: 'neutral' },
};

export function ResponseStatusBadge({ status }: { status: string }) {
  const entry = RESPONSE_STATUS_MAP[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={entry.tone} label={entry.label} />;
}

const PROXY_STATUS_MAP: Record<string, { label: string; tone: Tone }> = {
  unknown: { label: 'Chưa kiểm tra', tone: 'neutral' },
  healthy: { label: 'Khỏe mạnh', tone: 'ok' },
  unhealthy: { label: 'Bất thường', tone: 'danger' },
  cooldown: { label: 'Đang làm nguội', tone: 'warn' },
};

export function ProxyStatusBadge({ status }: { status: string }) {
  const entry = PROXY_STATUS_MAP[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={entry.tone} label={entry.label} />;
}

const CAPABILITY_STATUS_MAP: Record<string, { label: string; tone: Tone }> = {
  native: { label: 'Hỗ trợ gốc', tone: 'ok' },
  local: { label: 'Hiện thực cục bộ', tone: 'ok' },
  upstream_decided: { label: 'Tùy thuộc upstream', tone: 'warn' },
  experimental: { label: 'Thử nghiệm', tone: 'info' },
  unsupported: { label: 'Không hỗ trợ', tone: 'neutral' },
};

export function CapabilityStatusBadge({ status }: { status: string }) {
  const entry = CAPABILITY_STATUS_MAP[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={entry.tone} label={entry.label} />;
}

export function BoolBadge({ value, trueLabel, falseLabel }: { value: boolean; trueLabel: string; falseLabel: string }) {
  return value ? <Badge tone="ok" label={trueLabel} /> : <Badge tone="neutral" label={falseLabel} />;
}
