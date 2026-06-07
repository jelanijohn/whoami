<script lang="ts">
  import { app } from '$lib/state.svelte';

  let html = $state('');
  let loaded = $state(false);

  async function load() {
    html = await app.siteHtml();
    loaded = true;
  }

  $effect(() => {
    void app.entries;
    void app.profile;
    if (app.store) load();
  });

  async function copy() {
    await navigator.clipboard.writeText(html);
    app.message = 'Site HTML copied';
  }
</script>

<div class="space-y-3">
  <div class="flex items-center gap-2">
    <h1 class="text-lg font-semibold">Personal site</h1>
    <span class="text-xs text-[var(--color-muted)]">a standalone .html you can drop on any static host</span>
    <div class="ml-auto flex gap-2">
      <button class="rounded border border-[var(--color-line)] px-2.5 py-1 text-sm hover:bg-gray-50" onclick={copy}>Copy HTML</button>
      <button class="rounded border border-[var(--color-line)] px-2.5 py-1 text-sm hover:bg-gray-50" onclick={() => app.exportSite()}>Export to dist/</button>
    </div>
  </div>

  {#if loaded}
    <iframe
      title="Site preview"
      srcdoc={html}
      class="h-[70vh] w-full rounded-lg border border-[var(--color-line)] bg-white shadow-sm"
      sandbox="allow-same-origin"
    ></iframe>
  {:else}
    <p class="text-sm text-[var(--color-muted)]">Generating…</p>
  {/if}
</div>
