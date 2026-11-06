const KEY = 'mero.theme';

type Theme = 'light' | 'dark';
const listeners = new Set<(dark: boolean) => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function isDark(): boolean {
  return document.documentElement.dataset.theme === 'dark';
}

/** Applies the saved theme, or the system's if none was chosen. */
export function initTheme() {
  const t = stored() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
}

export function toggleTheme() {
  const t: Theme = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable */
  }
  for (const fn of listeners) fn(t === 'dark');
}

export function onThemeChange(fn: (dark: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
