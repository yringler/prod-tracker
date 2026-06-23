import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sp-theme';
// Keep these in sync with the <meta name="theme-color"> values and the --bg vars
// in styles.css so mobile browser chrome matches the active theme.
const THEME_COLOR: Record<Theme, string> = { dark: '#0b1020', light: '#f5f7fb' };

/** Resolve the initial theme: saved choice wins, else the OS preference, else dark. */
function initialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(initialTheme());

  constructor() {
    // Apply the theme on init and on every change: swap the wa-* class on <html>,
    // persist the choice, and update the browser chrome color. The inline boot
    // script in index.html sets the class before first paint; this keeps it in sync.
    effect(() => {
      const theme = this.theme();
      const root = document.documentElement;
      root.classList.toggle('wa-dark', theme === 'dark');
      root.classList.toggle('wa-light', theme === 'light');
      localStorage.setItem(STORAGE_KEY, theme);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLOR[theme]);
    });
  }

  toggle(): void {
    this.theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }
}
