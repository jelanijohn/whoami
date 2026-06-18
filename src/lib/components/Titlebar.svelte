<script lang="ts">
  // Unified app header — Who Am I draws its own window chrome across the full
  // window width in place of the stock OS title bar.
  //
  //   Row 1 (window chrome): brand mark + the open-record breadcrumb, then the
  //   record actions (git status, theme, folder, Sync). On Windows/Linux the OS
  //   frame is turned off (lib.rs) so we draw our own min/maximize/close caption
  //   buttons here; macOS keeps its native traffic lights via the Overlay
  //   title-bar style (tauri.conf.json) and we reserve a leading inset for them.
  //
  //   Row 2: the section tabs (Journal … Data).
  //
  // The bar is a Tauri drag region; the static brand/breadcrumb text is too, so
  // the window can be dragged from the empty stretches. Buttons and links are
  // not drag regions, so they stay clickable.
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { page } from '$app/state';
  import { app } from '$lib/state.svelte';
  import { theme } from '$lib/theme.svelte';
  import BrandMark from './BrandMark.svelte';
  import AppMenu from './AppMenu.svelte';

  const nav = [
    { href: '/', label: 'Journal' },
    { href: '/import', label: 'Import' },
    { href: '/inbox', label: 'Inbox' },
    { href: '/projects', label: 'Projects' },
    { href: '/profile', label: 'Profile' },
    { href: '/resume', label: 'Resume' },
    { href: '/site', label: 'Personal site' },
    { href: '/data', label: 'Data' }
  ];

  // Platform decides whether (and where) we draw caption buttons — sniff the
  // webview userAgent, no extra plugin. WKWebView → macOS (native traffic
  // lights), WebView2 → Windows, WebKitGTK (Linux/WSL) → Linux.
  function detectPlatform(): 'macos' | 'windows' | 'linux' {
    const ua = navigator.userAgent;
    if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
    if (/Windows/.test(ua)) return 'windows';
    return 'linux';
  }

  let plat = $state<'macos' | 'windows' | 'linux'>(detectPlatform());
  let maximized = $state(false);
  const isMac = $derived(plat === 'macos');
  const win = getCurrentWindow();

  // The git working-tree summary, shown as a detail chip plus a glanceable dot
  // on the breadcrumb. Mirrors the layout's previous derivation verbatim.
  const gitChip = $derived.by(() => {
    const g = app.git;
    if (!g) return null;
    if (!g.isRepo) return { text: 'no git', tone: 'muted' as const };
    if (g.inProgress) return { text: 'conflict — resolve by hand', tone: 'warn' as const };
    const bits: string[] = [];
    if (!g.clean) bits.push(`${g.changedFiles} changed`);
    if (g.ahead) bits.push(`↑${g.ahead}`);
    if (g.behind) bits.push(`↓${g.behind}`);
    if (!bits.length) return { text: `clean · ${g.branch ?? ''}`, tone: 'ok' as const };
    return { text: bits.join(' · '), tone: g.clean ? ('ok' as const) : ('warn' as const) };
  });

  const dotColor = $derived(
    gitChip?.tone === 'ok'
      ? '#16a34a'
      : gitChip?.tone === 'warn'
        ? '#d97706'
        : 'var(--color-muted)'
  );

  function folderName(path: string | null): string {
    if (!path) return '';
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        maximized = await win.isMaximized();
        unlisten = await win.onResized(async () => {
          maximized = await win.isMaximized();
        });
      } catch {
        // Window APIs unavailable (plain `vite dev` in a browser) — the caption
        // buttons simply won't do anything there.
      }
    })();
    return () => unlisten?.();
  });
</script>

<div class="chrome border-b border-[var(--color-line)]">
  <!-- Row 1 — window chrome -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="bar"
    data-platform={plat}
    data-tauri-drag-region
    ondblclick={() => !isMac && win.toggleMaximize()}
  >
    {#if isMac}
      <!-- Reserve space for the native traffic lights (Overlay style). -->
      <span class="mac-inset" data-tauri-drag-region></span>
    {/if}

    <span class="brandchip"><BrandMark size={22} /></span>
    <span class="wordmark" data-tauri-drag-region>Who Am I</span>

    {#if app.recordRoot}
      <span class="chev" data-tauri-drag-region>
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </span>
      <span class="dot" style="background: {dotColor};"></span>
      <button
        class="crumb"
        title={app.recordRoot}
        onclick={() => app.chooseFolder()}
      >{folderName(app.recordRoot)}</button>
    {/if}

    <div class="actions" data-platform={plat}>
      {#if app.busy}
        <span class="text-[11.5px] text-[var(--color-muted)] pr-1">working…</span>
      {/if}

      {#if gitChip}
        <span
          class="rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap {gitChip.tone === 'ok'
            ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300'
            : gitChip.tone === 'warn'
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
              : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'}"
        >{gitChip.text}</span>
      {/if}

      <button
        class="grid h-7 w-7 place-items-center rounded text-[var(--color-muted)] hover:bg-black/5 hover:text-[var(--color-ink)] dark:hover:bg-white/10"
        title={theme.current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label="Toggle dark mode"
        onclick={() => theme.toggle()}
      >
        {#if theme.current === 'dark'}
          <!-- sun -->
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        {:else}
          <!-- moon -->
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        {/if}
      </button>

      <AppMenu />

      {#if app.recordRoot}
        <button
          class="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-black/5 hover:text-[var(--color-ink)] dark:hover:bg-white/10"
          title="Open a different record folder"
          onclick={() => app.chooseFolder()}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          Change
        </button>
        <button
          class="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={app.busy}
          onclick={() => app.sync()}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class={app.busy ? 'spin' : ''}>
            <path d="M21 12a9 9 0 0 1-15.6 6.1M3 12A9 9 0 0 1 18.6 5.9" />
            <path d="M18.6 2.5v3.4h-3.4M5.4 21.5v-3.4h3.4" />
          </svg>
          Sync
        </button>
      {/if}
    </div>

    {#if !isMac}
      <!-- Windows / Linux: custom caption buttons, flush to the corner. -->
      <div class="caption">
        <button class="cap" title="Minimize" aria-label="Minimize" onclick={() => win.minimize()}>
          <svg viewBox="0 0 10 10"><line x1="0" y1="5.5" x2="10" y2="5.5" /></svg>
        </button>
        <button class="cap" title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'} onclick={() => win.toggleMaximize()}>
          {#if maximized}
            <svg viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" /><path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" /></svg>
          {:else}
            <svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
          {/if}
        </button>
        <button class="cap close" title="Close" aria-label="Close" onclick={() => win.close()}>
          <svg viewBox="0 0 10 10"><path d="M0.7 0.7 L9.3 9.3 M9.3 0.7 L0.7 9.3" /></svg>
        </button>
      </div>
    {/if}
  </div>

  <!-- Row 2 — section tabs -->
  <nav class="tabs">
    {#each nav as item (item.href)}
      <a
        href={item.href}
        class="tab {page.url.pathname === item.href
          ? 'bg-[var(--color-accent)]/10 font-medium text-[var(--color-accent)]'
          : 'text-[var(--color-muted)] hover:bg-black/5 dark:hover:bg-white/10'}"
      >{item.label}</a>
    {/each}
  </nav>
</div>

<style>
  .chrome {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    background: var(--color-bar);
    user-select: none;
    -webkit-user-select: none;
  }

  .bar {
    position: relative;
    display: flex;
    align-items: center;
    height: 42px;
    padding-left: 14px;
    overflow: hidden;
  }
  .bar[data-platform='macos'] {
    padding-left: 0; /* the mac-inset reserves the leading space */
  }
  .mac-inset {
    width: 78px;
    height: 100%;
    flex-shrink: 0;
  }

  .brandchip {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex-shrink: 0;
  }
  .wordmark {
    margin-left: 9px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--color-ink);
    white-space: nowrap;
  }
  .chev {
    display: inline-flex;
    color: var(--color-muted);
    opacity: 0.6;
    margin: 0 2px 0 6px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-right: 7px;
    flex-shrink: 0;
  }
  .crumb {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
    padding: 2px 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  .crumb:hover {
    color: var(--color-ink);
    background: color-mix(in srgb, var(--color-ink) 6%, transparent);
  }

  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding-left: 8px;
  }
  .actions[data-platform='macos'] {
    padding-right: 10px; /* breathing room from the corner */
  }

  .caption {
    display: flex;
    height: 42px;
    margin-left: 4px;
    flex-shrink: 0;
  }
  .cap {
    width: 44px;
    height: 42px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
  }
  .cap:hover {
    background: color-mix(in srgb, var(--color-ink) 8%, transparent);
    color: var(--color-ink);
  }
  .cap.close:hover {
    background: #e81123;
    color: #fff;
  }
  .cap svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 10px 7px;
    overflow-x: auto;
  }
  .tab {
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 13px;
    white-space: nowrap;
  }

  /* Spin the Sync glyph while a sync/refresh is running. */
  :global(.spin) {
    animation: tb-spin 0.9s linear infinite;
    transform-origin: center;
  }
  @keyframes tb-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
