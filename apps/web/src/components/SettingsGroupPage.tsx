import { useEffect, useState } from 'react';
import { api, type SettingsGroupName, type SettingsResponse } from '../api';
import { formatDateTime, formatMsWithDuration } from '../util/format';
import { ErrorBanner } from './ErrorBanner';
import { Layout } from './Layout';
import { AsyncSection } from './StateBlock';

export interface SettingFieldMeta {
  key: string;
  label: string;
  kind: 'boolean' | 'number' | 'string' | 'select' | 'datetime' | 'string_list';
  options?: { value: string; label: string }[];
  hint?: string;
  /** Đơn vị hiển thị trường số: 'ms' thì bên cạnh ô nhập có thêm hiển thị dạng dễ đọc 'N ms (X ngày/giờ/phút)', giá trị gửi lên vẫn là mili-giây. */
  unit?: 'ms';
  min?: number;
  max?: number;
}

const SOURCE_LABEL: Record<string, string> = {
  env: 'Biến môi trường',
  db: 'Cơ sở dữ liệu',
  default: 'Mặc định',
};

/**
 * Chuyển giá trị của mục cài đặt thành văn bản hiển thị trong ô nhập.
 * Xử lý riêng biệt theo từng kiểu dữ liệu thực tế thay vì dùng JSON.stringify một cách thô bạo.
 */
function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => formatSettingValue(item)).join(' ');
  return '';
}

/**
 * Trình render nhóm cài đặt chung: mỗi nhóm một thẻ card, metadata các trường do bên gọi truyền vào.
 * Quy tắc: mục có `source="env"` thì `editable=false`, vô hiệu hóa ô nhập trên UI và kèm thông báo cố định bởi biến môi trường.
 */
export function SettingsGroupPage({
  title,
  subtitle,
  groups,
}: {
  title: string;
  subtitle: string;
  groups: Array<{ group: SettingsGroupName; heading: string; fields: SettingFieldMeta[] }>;
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .getSettings()
      .then((res) => setData(res))
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <Layout title={title} subtitle={subtitle}>
      <AsyncSection loading={loading} error={error} data={data} onRetry={load}>
        {(settings) => (
          <>
            {groups.map((g) => (
              <SettingsGroupCard
                key={g.group}
                heading={g.heading}
                group={g.group}
                fields={g.fields}
                values={settings[g.group] as unknown as Record<
                  string,
                  { value: unknown; source: string; editable: boolean; requires_restart: boolean }
                >}
                onSaved={load}
              />
            ))}
          </>
        )}
      </AsyncSection>
    </Layout>
  );
}

function SettingsGroupCard({
  heading,
  group,
  fields,
  values,
  onSaved,
}: {
  heading: string;
  group: SettingsGroupName;
  fields: SettingFieldMeta[];
  values: Record<string, { value: unknown; source: string; editable: boolean; requires_restart: boolean }>;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, values[f.key]?.value])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const handleSubmit = () => {
    setSaving(true);
    setError(null);
    const changed: Record<string, unknown> = {};
    let needsRestart = false;
    for (const f of fields) {
      if (values[f.key]?.editable === true) {
        changed[f.key] = draft[f.key];
        if (values[f.key]?.requires_restart === true) needsRestart = true;
      }
    }
    api
      .updateSettings(group, changed)
      .then(() => {
        setSavedAt(Date.now());
        setRestartNeeded(needsRestart);
        onSaved();
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  };

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{heading}</h2>
        {savedAt !== null && <span className="text-faint">Đã lưu lúc {formatDateTime(savedAt)}</span>}
      </div>
      {savedAt !== null && restartNeeded && (
        <div className="field-hint" style={{ marginBottom: 12 }}>
          <span className="badge badge-warn">Cần khởi động lại</span> Thay đổi bao gồm mục cần khởi động lại, dịch vụ vẫn chạy theo giá trị cũ cho đến khi khởi động lại.
        </div>
      )}
      {fields.map((f) => {
        const meta = values[f.key];
        const editable = meta?.editable ?? false;
        return (
          <div className="field" key={f.key}>
            <label htmlFor={`setting-${group}-${f.key}`}>
              {f.label}{' '}
              <span className="badge badge-neutral" style={{ marginLeft: 6 }}>
                {SOURCE_LABEL[meta?.source ?? 'default'] ?? meta?.source}
              </span>
              {meta?.requires_restart === true && (
                <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                  Cần restart
                </span>
              )}
            </label>
            <SettingInput
              id={`setting-${group}-${f.key}`}
              meta={f}
              value={draft[f.key]}
              disabled={!editable}
              onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
            />
            {f.unit === 'ms' && <span className="field-hint">{formatMsWithDuration(draft[f.key])}</span>}
            {!editable && (
              <span className="field-hint">
                {meta?.source === 'env'
                  ? 'Được cố định bởi biến môi trường, sửa tại đây sẽ không có hiệu lực.'
                  : 'Hiện tại không thể sửa đổi trên giao diện.'}
              </span>
            )}
            {f.hint !== undefined && <span className="field-hint">{f.hint}</span>}
          </div>
        );
      })}
      {error !== null && (
        <div style={{ marginBottom: 12 }}>
          <ErrorBanner error={error} />
        </div>
      )}
      <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
        {saving ? 'Đang lưu…' : 'Lưu cài đặt'}
      </button>
    </div>
  );
}

function SettingInput({
  id,
  meta,
  value,
  disabled,
  onChange,
}: {
  id: string;
  meta: SettingFieldMeta;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  if (meta.kind === 'boolean') {
    return (
      <label className="checkbox-row">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {value === true ? 'Đã bật' : 'Đã tắt'}
      </label>
    );
  }
  if (meta.kind === 'select') {
    return (
      <select
        id={id}
        value={formatSettingValue(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {meta.options?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  if (meta.kind === 'number') {
    return (
      <input
        id={id}
        type="number"
        min={meta.min}
        max={meta.max}
        value={formatSettingValue(value)}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === '') {
            onChange(null);
            return;
          }
          let next = Number(e.target.value);
          if (meta.min !== undefined && next < meta.min) next = meta.min;
          if (meta.max !== undefined && next > meta.max) next = meta.max;
          onChange(next);
        }}
      />
    );
  }
  if (meta.kind === 'string_list') {
    // Phía server là mảng chuỗi, giao diện hiển thị chỉnh sửa một dòng phân tách bằng dấu cách, chuyển lại thành mảng trước khi gửi.
    const text = Array.isArray(value) ? value.join(' ') : '';
    return (
      <input
        id={id}
        type="text"
        value={text}
        disabled={disabled}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/\s+/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
      />
    );
  }
  return (
    <input
      id={id}
      type="text"
      value={formatSettingValue(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
