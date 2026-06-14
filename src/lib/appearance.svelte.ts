/**
 * Appearance preferences beyond light/dark (Svelte 5 runes): an accent colour
 * and a display density.
 *
 * Both are personal-machine preferences — like the theme and the LLM config,
 * they live in localStorage, never in the record repo — and both are applied
 * directly to <html> as inline overrides so no `app.css` change is needed:
 *
 *   accent  → overrides `--color-accent`. Every `var(--color-accent)` usage
 *             (buttons, active tab, links) picks it up for free. `null` is
 *             "Default": the override is removed so the built-in light/dark
 *             accent from `app.css` resumes.
 *   density → scales the root font-size. Tailwind's spacing/typography are in
 *             rem, so "compact" tightens the whole document body in one move.
 *             (The window chrome in Titlebar.svelte is px-fixed and stays put.)
 */

const LS_ACCENT = 'whoami:accent';
const LS_DENSITY = 'whoami:density';

export type Density = 'comfortable' | 'compact';

/**
 * Selectable accent swatches. `value: null` is "Default" — picking it clears
 * the override so the built-in light/dark accent resumes. The palette is kept
 * deliberately calm to match the document-like surface.
 */
export const ACCENTS: { name: string; value: string | null }[] = [
  { name: 'Default', value: null },
  { name: 'Teal', value: '#0d9488' },
  { name: 'Emerald', value: '#15803d' },
  { name: 'Plum', value: '#7c3aed' },
  { name: 'Rose', value: '#be123c' },
  { name: 'Amber', value: '#b45309' },
  { name: 'Slate', value: '#475569' }
];

/** Root font-size applied in compact mode (~9% tighter than the 16px default). */
const COMPACT_ROOT_FONT = '14.5px';

class Appearance {
  /** Active accent override (hex), or null to use the built-in token default. */
  accent = $state<string | null>(null);
  /** Display density. */
  density = $state<Density>('comfortable');

  /** Read saved preferences and apply them to <html>. Call once on launch. */
  init(): void {
    if (typeof localStorage !== 'undefined') {
      const a = localStorage.getItem(LS_ACCENT);
      this.accent = a && a !== 'default' ? a : null;
      this.density = localStorage.getItem(LS_DENSITY) === 'compact' ? 'compact' : 'comfortable';
    }
    this.applyAccent();
    this.applyDensity();
  }

  /** Set (or, with null, clear) the accent override, then persist + apply. */
  setAccent(value: string | null): void {
    this.accent = value;
    if (typeof localStorage !== 'undefined') {
      if (value) localStorage.setItem(LS_ACCENT, value);
      else localStorage.removeItem(LS_ACCENT);
    }
    this.applyAccent();
  }

  /** Set the density, then persist + apply. */
  setDensity(value: Density): void {
    this.density = value;
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_DENSITY, value);
    this.applyDensity();
  }

  private applyAccent(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (this.accent) root.style.setProperty('--color-accent', this.accent);
    else root.style.removeProperty('--color-accent');
  }

  private applyDensity(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.style.fontSize = this.density === 'compact' ? COMPACT_ROOT_FONT : '';
  }
}

export const appearance = new Appearance();
