<script lang="ts">
  // Appearance & connections menu — a gear popover that lives in the unified
  // header (Titlebar.svelte), mirroring waid's AppMenu. Appearance controls
  // (theme, accent, density) up top; below, a read-only snapshot of the open
  // record's connections (source tokens + AI provider) with jumps to the routes
  // that actually own them: source tokens live in Import, the AI provider + key
  // in Data. This menu only reflects their state, it doesn't duplicate entry.
  //
  // The bar clips overflow, so the popover is `position: fixed`, anchored to the
  // trigger button's measured rect — that escapes the clip and stays put while
  // open.
  import { theme } from '$lib/theme.svelte';
  import { appearance, ACCENTS, type Density } from '$lib/appearance.svelte';
  import { app } from '$lib/state.svelte';

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement>();
  let pos = $state<{ top: number; right: number }>({ top: 48, right: 8 });

  function toggle() {
    if (!open && triggerEl) {
      const r = triggerEl.getBoundingClientRect();
      pos = { top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) };
    }
    open = !open;
  }

  function close() {
    open = false;
  }

  const DENSITIES: { value: Density; label: string }[] = [
    { value: 'comfortable', label: 'Comfortable' },
    { value: 'compact', label: 'Compact' }
  ];

  const THEMES: { value: 'light' | 'dark'; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
  ];

  // Source-token presence is loaded once a record is open (state.refreshTokenPresence).
  const sources: { key: 'github' | 'asana' | 'gmail'; label: string }[] = [
    { key: 'github', label: 'GitHub' },
    { key: 'asana', label: 'Asana' },
    { key: 'gmail', label: 'Gmail' }
  ];
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

<button
  bind:this={triggerEl}
  class="grid h-7 w-7 place-items-center rounded hover:bg-black/5 hover:text-[var(--color-ink)] dark:hover:bg-white/10 {open
    ? 'bg-black/5 text-[var(--color-ink)] dark:bg-white/10'
    : 'text-[var(--color-muted)]'}"
  title="Appearance & connections"
  aria-label="Appearance and connections"
  aria-haspopup="menu"
  aria-expanded={open}
  onclick={toggle}
>
  <!-- gear -->
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
</button>

{#if open}
  <!-- click-away layer -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <button class="fixed inset-0 z-40 cursor-default" aria-label="Close menu" onclick={close}></button>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="menu"
    tabindex="-1"
    class="appmenu fixed z-50 w-[264px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-bar)]"
    style="top: {pos.top}px; right: {pos.right}px;"
  >
    <div class="p-3">
      <div class="label">Theme</div>
      <div class="seg mb-3">
        {#each THEMES as t (t.value)}
          <button
            class="seg-btn {theme.current === t.value ? 'seg-on' : ''}"
            onclick={() => theme.set(t.value)}
          >
            {t.label}
          </button>
        {/each}
      </div>

      <div class="label">Accent</div>
      <div class="mb-3 flex flex-wrap gap-2">
        {#each ACCENTS as a (a.name)}
          <button
            class="swatch {appearance.accent === a.value ? 'swatch-on' : ''}"
            style="background: {a.value ?? 'var(--color-paper)'};"
            title={a.name}
            aria-label={a.name}
            onclick={() => appearance.setAccent(a.value)}
          >
            {#if a.value === null}
              <span class="swatch-auto"></span>
            {/if}
          </button>
        {/each}
      </div>

      <div class="label">Density</div>
      <div class="seg">
        {#each DENSITIES as d (d.value)}
          <button
            class="seg-btn {appearance.density === d.value ? 'seg-on' : ''}"
            onclick={() => appearance.setDensity(d.value)}
          >
            {d.label}
          </button>
        {/each}
      </div>
    </div>

    {#if app.recordRoot}
      <div class="border-t border-[var(--color-line)] p-3">
        <div class="label">Connections</div>
        <div class="space-y-1.5">
          {#each sources as s (s.key)}
            <div class="row">
              <span
                class="dot"
                style="background: {app.tokenPresent[s.key] ? '#16a34a' : 'var(--color-line)'};"
              ></span>
              <span class="row-label">{s.label}</span>
              <span class="row-state">{app.tokenPresent[s.key] ? 'connected' : 'not set'}</span>
            </div>
          {/each}
          <div class="row">
            <span
              class="dot"
              style="background: {app.llmReady
                ? '#16a34a'
                : app.llmConfig
                  ? '#d97706'
                  : 'var(--color-line)'};"
            ></span>
            <span class="row-label">AI provider</span>
            <span class="row-state">
              {app.llmReady ? (app.llmConfig?.provider ?? 'ready') : app.llmConfig ? 'not ready' : 'off'}
            </span>
          </div>
        </div>
        <div class="mt-2.5 flex gap-3">
          <a href="/import" class="jump" onclick={close}>Manage in Import →</a>
          <a href="/data" class="jump" onclick={close}>AI in Data →</a>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .label {
    margin-bottom: 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .seg {
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--color-line);
    border-radius: 9px;
  }
  .seg-btn {
    flex: 1;
    border-radius: 7px;
    padding: 4px 8px;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--color-muted);
    background: transparent;
    cursor: pointer;
  }
  .seg-btn:hover {
    color: var(--color-ink);
  }
  .seg-on,
  .seg-on:hover {
    background: var(--color-accent);
    color: #fff;
  }

  .swatch {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 9999px;
    cursor: pointer;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-ink) 14%, transparent);
    transition: transform 0.12s ease;
  }
  .swatch:hover {
    transform: scale(1.1);
  }
  .swatch-on {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  /* The "Default" swatch reads as auto via a small muted dot on paper. */
  .swatch-auto {
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--color-muted);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .dot {
    width: 7px;
    height: 7px;
    flex-shrink: 0;
    border-radius: 9999px;
  }
  .row-label {
    color: var(--color-ink);
  }
  .row-state {
    margin-left: auto;
    font-size: 11px;
    color: var(--color-muted);
  }

  .jump {
    font-size: 11px;
    color: var(--color-accent);
    text-decoration: none;
  }
  .jump:hover {
    text-decoration: underline;
  }

  .appmenu {
    box-shadow: 0 12px 32px -8px color-mix(in srgb, var(--color-ink) 30%, transparent);
  }
</style>
