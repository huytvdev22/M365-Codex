import { useState } from 'react';
import { CopyButton } from './CopyButton';

/**
 * Sau khi tạo API Key, khóa rõ chỉ xuất hiện lần này duy nhất — máy chủ không lưu văn bản thô, sau đó không thể lấy lại.
 * Trước khi đóng bắt buộc phải tích chọn "Tôi đã lưu lại khóa bí mật này" để tránh người dùng lỡ tay đóng mất khóa.
 */
export function RevealApiKeyModal({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reveal-key-title">
      <div className="modal">
        <h2 id="reveal-key-title" style={{ marginTop: 0 }}>
          Khóa API Đã Được Tạo
        </h2>
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <div className="error-title">Đây là lần duy nhất hiển thị toàn bộ khóa bí mật</div>
          <div>Sau khi đóng cửa sổ này, máy chủ sẽ không lưu văn bản thô và không thể xem lại — vui lòng sao chép và lưu trữ cẩn thận ngay.</div>
        </div>
        <div className="mono-copy" style={{ width: '100%', justifyContent: 'space-between' }}>
          <span style={{ overflowWrap: 'anywhere' }}>{apiKey}</span>
        </div>
        <div style={{ marginTop: 10 }}>
          <CopyButton value={apiKey} label="Sao chép khóa" />
        </div>
        <label className="checkbox-row" style={{ marginTop: 20 }}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          Tôi đã lưu lại khóa bí mật này
        </label>
        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-primary" disabled={!confirmed} onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
