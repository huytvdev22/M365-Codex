import { useState } from 'react';
import { IconCheck, IconCopy } from './icons';

/** Sao chép vào clipboard; hiển thị dấu tích phản hồi ngắn sau khi sao chép. Thất bại trong im lặng nếu Clipboard API không khả dụng. */
export function CopyButton({ value, label = 'Sao chép' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* Trường hợp quyền truy cập clipboard bị từ chối: không làm phiền người dùng, giữ im lặng */
      });
  };

  return (
    <button type="button" className="btn btn-sm" onClick={handleCopy}>
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? 'Đã sao chép' : label}
    </button>
  );
}
