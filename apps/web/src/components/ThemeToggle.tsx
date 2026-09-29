import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons';

type Preference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'm365codex.theme';

function apply(pref: Preference): void {
  const root = document.documentElement;
  if (pref === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref);
  }
}

function initial(): Preference {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** Tùy chọn giao diện cá nhân, lưu trong sessionStorage; mặc định theo hệ thống. */
export function ThemeToggle() {
  const [pref, setPref] = useState<Preference>(initial);

  useEffect(() => {
    apply(pref);
    sessionStorage.setItem(STORAGE_KEY, pref);
  }, [pref]);

  const next = (): Preference => (pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system');

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setPref(next())}
      title="Chuyển đổi giao diện (Theo hệ thống / Sáng / Tối)"
    >
      {pref === 'dark' ? <IconMoon /> : <IconSun />}
      {' '}
      {pref === 'system' ? 'Theo hệ thống' : pref === 'light' ? 'Giao diện sáng' : 'Giao diện tối'}
    </button>
  );
}
