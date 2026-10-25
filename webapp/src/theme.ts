import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'pp_theme';
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Светлая тема по умолчанию; выбор пользователя сохраняется на устройстве. */
export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0B111B' : '#F4F2FF');
  try {
    if (theme === 'dark') localStorage.setItem(KEY, 'dark');
    else localStorage.removeItem(KEY);
  } catch {
    /* хранилище недоступно — тема действует до перезагрузки */
  }
  listeners.forEach((l) => l());
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getTheme,
    () => 'light' as Theme,
  );
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')];
}
