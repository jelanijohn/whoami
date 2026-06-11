<script lang="ts">
  import { app } from '$lib/state.svelte';

  let md = $state('');
  let loaded = $state(false);

  async function load() {
    md = await app.resumeMarkdown();
    loaded = true;
  }

  // Load once a store is open, and whenever entries change.
  $effect(() => {
    // touch reactive deps so this re-runs when the record updates
    void app.entries;
    void app.profile;
    if (app.store) load();
  });

  async function copy() {
    await navigator.clipboard.writeText(md);
    app.message = 'Resume Markdown copied';
  }
</script>

<div class="space-y-3">
  <div class="flex items-center gap-2">
    <h1 class="text-lg font-semibold">Resume</h1>
    <span class="text-xs text-[var(--color-muted)]">private entries are never included</span>
    <div class="ml-auto flex gap-2">
      <button class="rounded border border-[var(--color-line)] px-2.5 py-1 text-sm hover:bg-gray-50 dark:hover:bg-white/5" onclick={copy}>Copy Markdown</button>
      <button class="rounded border border-[var(--color-line)] px-2.5 py-1 text-sm hover:bg-gray-50 dark:hover:bg-white/5" onclick={() => app.exportResume()}>Export to dist/</button>
      <button class="rounded border border-[var(--color-line)] px-2.5 py-1 text-sm hover:bg-gray-50 dark:hover:bg-white/5" onclick={() => window.print()}>Print / PDF</button>
    </div>
  </div>

  {#if loaded}
    <pre class="whitespace-pre-wrap rounded-lg border border-[var(--color-line)] bg-white p-5 font-mono text-sm leading-relaxed shadow-sm dark:bg-[#1e1f24] dark:shadow-none print:border-0 print:bg-white print:text-black print:shadow-none">{md}</pre>
  {:else}
    <p class="text-sm text-[var(--color-muted)]">Generating…</p>
  {/if}
</div>
