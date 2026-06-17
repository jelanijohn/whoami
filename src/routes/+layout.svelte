<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { theme } from '$lib/theme.svelte';
  import { appearance } from '$lib/appearance.svelte';
  import Titlebar from '$lib/components/Titlebar.svelte';

  let { children } = $props();

  onMount(() => {
    theme.init();
    appearance.init();
    app.init();
  });
</script>

<div class="flex h-full flex-col">
  <!-- Unified window-chrome header: brand + open-record breadcrumb + actions,
       with the section tabs on the second row. -->
  <Titlebar />

  <!-- Toast -->
  {#if app.error}
    <div class="border-b border-red-200 bg-red-50 px-4 py-1.5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{app.error}</div>
  {:else if app.message}
    <div class="border-b border-green-200 bg-green-50 px-4 py-1.5 text-sm text-green-700 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-300">
      {app.message}
    </div>
  {/if}

  <!-- Body -->
  <main class="flex-1 overflow-auto">
    {#if !app.recordRoot}
      <div class="mx-auto mt-24 max-w-md text-center">
        <h1 class="text-2xl font-semibold">Open your record</h1>
        <p class="mt-2 text-sm text-[var(--color-muted)]">
          Pick the folder that holds (or will hold) your Who Am I record. It's a plain Git repo of
          Markdown files — the canonical store. The app builds a throwaway index next to it.
        </p>
        <button
          class="mt-6 rounded bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          onclick={() => app.chooseFolder()}
        >
          Choose folder…
        </button>
      </div>
    {:else}
      <div class="mx-auto max-w-6xl p-4">
        {@render children()}
      </div>
    {/if}
  </main>
</div>
