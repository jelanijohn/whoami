<script lang="ts">
  // A small "?" help icon that opens an in-app modal explaining how to obtain
  // the credential it sits beside — numbered steps, required scopes, a note, and
  // a link to the provider's docs (opened in the system browser). Topics live in
  // $lib/credentialHelp. Styling mirrors the inbox dialog.
  import { credentialHelp } from '$lib/credentialHelp';
  import { open as openExternal } from '@tauri-apps/plugin-shell';

  let { topic, size = 14 }: { topic: string; size?: number } = $props();

  let open = $state(false);

  const help = $derived(credentialHelp[topic]);

  async function openDocs(url: string) {
    // Tauri-only; in browser-only `pnpm dev` this throws — degrade gracefully.
    try {
      await openExternal(url);
    } catch {
      /* no system shell available */
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      open = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if help}
  <button
    type="button"
    class="grid shrink-0 place-items-center rounded-full border border-[var(--color-line)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    style="height: {size + 6}px; width: {size + 6}px;"
    title="How to get this"
    aria-label="How to get this credential"
    onclick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      open = true;
    }}
  >
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) open = false;
      }}
    >
      <div
        class="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-[var(--color-line)] bg-white shadow-lg dark:bg-[#1e1f24]"
        role="dialog"
        aria-modal="true"
        aria-label={help.title}
      >
        <!-- Header -->
        <div class="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3">
          <h3 class="text-sm font-semibold">{help.title}</h3>
          <button
            type="button"
            class="grid h-7 w-7 place-items-center rounded text-[var(--color-muted)] transition-colors hover:bg-gray-100 hover:text-[var(--color-ink)] dark:hover:bg-white/10"
            aria-label="Close"
            onclick={() => (open = false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto px-5 py-4">
          <ol class="flex flex-col gap-2 text-sm leading-relaxed">
            {#each help.steps as step, i (i)}
              <li class="flex gap-2.5">
                <span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-accent)] text-xs font-semibold text-white">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            {/each}
          </ol>

          {#if help.scopes?.length}
            <div class="mt-4">
              <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Required scopes
              </div>
              <div class="flex flex-wrap gap-1.5">
                {#each help.scopes as scope (scope)}
                  <code class="rounded border border-[var(--color-line)] px-1.5 py-0.5 font-mono text-xs">
                    {scope}
                  </code>
                {/each}
              </div>
            </div>
          {/if}

          {#if help.note}
            <p class="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">{help.note}</p>
          {/if}
        </div>

        <!-- Footer -->
        {#if help.docsUrl}
          {@const docsUrl = help.docsUrl}
          <div class="border-t border-[var(--color-line)] px-5 py-3">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-sm font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10"
              onclick={() => openDocs(docsUrl)}
            >
              Open docs
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/if}
