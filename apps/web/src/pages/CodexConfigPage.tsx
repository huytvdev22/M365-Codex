import { useState } from 'react';
import { api, type CodexConfigResponse } from '../api';
import { CopyButton } from '../components/CopyButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { Layout } from '../components/Layout';

const DEFAULT_ENV_KEY = 'M365_CODEX_API_KEY';

export function CodexConfigPage() {
  const [apiKeyEnv, setApiKeyEnv] = useState(DEFAULT_ENV_KEY);
  const [config, setConfig] = useState<CodexConfigResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const generate = () => {
    setLoading(true);
    setError(null);
    api
      .getCodexConfig(apiKeyEnv.trim() || DEFAULT_ENV_KEY)
      .then((res) => setConfig(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  };

  return (
    <Layout title="Cấu hình Codex" subtitle="Tạo đoạn mã cấu hình để dán vào ~/.codex/config.toml">
      <div className="card">
        <div className="field">
          <label htmlFor="codex-env-key">Tên biến môi trường lưu trữ API Key</label>
          <input
            id="codex-env-key"
            type="text"
            value={apiKeyEnv}
            onChange={(e) => setApiKeyEnv(e.target.value)}
          />
          <span className="field-hint">
            Cấu hình tạo ra chỉ tham chiếu đến tên biến môi trường này, không ghi trực tiếp API Key thô vào TOML;
            vui lòng gán khóa bí mật <code>sk-</code> đã tạo vào biến môi trường này.
          </span>
        </div>
        {error !== null && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBanner error={error} />
          </div>
        )}
        <button type="button" className="btn btn-primary" onClick={generate} disabled={loading}>
          {loading ? 'Đang tạo…' : 'Tạo cấu hình'}
        </button>
      </div>

      {config !== null && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Đoạn mã cấu hình config.toml</h2>
            <CopyButton value={config.toml} label="Sao chép cấu hình" />
          </div>
          <pre className="mono" style={{ background: 'var(--bg-inset)', padding: 14, borderRadius: 'var(--radius-md)', overflowX: 'auto' }}>
            {config.toml}
          </pre>

          <div className="error-banner" style={{ marginTop: 4 }}>
            <div className="error-title">Về thuộc tính wire_api</div>
            <div>
              Kể từ tháng 2/2026, Codex chỉ hỗ trợ <code>wire_api = &quot;responses&quot;</code>
              (chế độ <code>&quot;chat&quot;</code> đã bị loại bỏ, khi lược bỏ cũng mặc định là responses). Đoạn mã này cố định sinh ra
              <code>wire_api = &quot;responses&quot;</code>; đồng thời endpoint <code>/v1/chat/completions</code>{' '}
              sẽ dành cho các client OpenAI tương thích khác thay vì bản thân Codex.
            </div>
          </div>

          {config.notes.length > 0 && (
            <ul style={{ marginTop: 14 }}>
              {config.notes.map((note) => (
                <li key={note} className="text-muted">
                  {note}
                </li>
              ))}
            </ul>
          )}

          <div className="text-muted" style={{ marginTop: 10 }}>
            Base URL API đối ngoại: <span className="mono">{config.base_url}</span>
          </div>
        </div>
      )}
    </Layout>
  );
}
