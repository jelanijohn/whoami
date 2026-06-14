/**
 * Light/dark theme toggle (Svelte 5 runes).
 *
 * The active theme is a `dark` class on <html>. An inline script in app.html
 * applies the saved (or system-preferred) theme before first paint to avoid a
 * flash; {@link ThemeState.init} then syncs this store to that already-applied
 * state, and {@link ThemeState.toggle} flips and persists the choice.
 */

const LS_THEME = 'whoami:theme';

export type Theme = 'light' | 'dark';

class ThemeState {
  /** The active theme. Seeded from the DOM in {@link init}. */
  current = $state<Theme>('light');

  /** Read the theme the pre-paint script already applied to <html>. */
  init(): void {
    if (typeof document === 'undefined') return;
    this.current = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }

  /** Flip between light and dark, applying and persisting the choice. */
  toggle(): void {
    this.set(this.current === 'dark' ? 'light' : 'dark');
  }

  /** Set the theme directly (used by the appearance menu's segmented control). */
  set(theme: Theme): void {
    this.current = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_THEME, theme);
  }
}

export const theme = new ThemeState();
