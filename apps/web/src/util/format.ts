/** Định dạng hiển thị: Bản địa hóa timestamp, số byte, thời lượng — timestamp trong quy ước là Unix ms, frontend chịu trách nhiệm hiển thị. */

export function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toLocaleString();
}

export function formatRelative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let text: string;
  if (abs < minute) text = 'Vừa xong';
  else if (abs < hour) text = `${Math.round(abs / minute)} phút`;
  else if (abs < day) text = `${Math.round(abs / hour)} giờ`;
  else text = `${Math.round(abs / day)} ngày`;
  if (text === 'Vừa xong') return text;
  return diff < 0 ? `${text} trước` : `${text} nữa`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ngày`);
  if (hours > 0) parts.push(`${hours} giờ`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} phút`);
  return parts.join(' ');
}

/** Hiển thị khoảng thời gian mili-giây dạng dễ đọc cho người dùng, ví dụ `2592000000 ms (30 ngày)`; ô nhập liệu vẫn gửi theo mili-giây. */
export function formatMsWithDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return `${ms} ms (${formatDuration(ms)})`;
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}
