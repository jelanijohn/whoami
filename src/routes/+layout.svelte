<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { app } from '$lib/state.svelte';

  let { children } = $props();

  onMount(() => {
    app.init();
  });

  const nav = [
    { href: '/', label: 'Journal' },
    { href: '/inbox', label: 'Inbox' },
    { href: '/profile', label: 'Profile' },
    { href: '/resume', label: 'Resume' },
    { href: '/site', label: 'Personal site' },
    { href: '/data', label: 'Data' }
  ];

  const gitChip = $derived.by(() => {
    const g = app.git;
    if (!g) return null;
    if (!g.isRepo) return { text: 'no git', tone: 'muted' };
    if (g.inProgress) return { text: 'conflict — resolve by hand', tone: 'warn' };
    const bits: string[] = [];
    if (!g.clean) bits.push(`${g.changedFiles} changed`);
    if (g.ahead) bits.push(`↑${g.ahead}`);
    if (g.behind) bits.push(`↓${g.behind}`);
    if (!bits.length) return { text: `clean · ${g.branch ?? ''}`, tone: 'ok' };
    return { text: bits.join(' · '), tone: g.clean ? 'ok' : 'warn' };
  });

  function folderName(path: string | null): string {
    if (!path) return '';
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }
</script>

<div class="flex h-full flex-col">
  <!-- Top bar -->
  <header class="flex items-center gap-3 border-b border-[var(--color-line)] bg-white px-4 py-2">
    <span class="font-semibold tracking-tight">Who Am I</span>

    <nav class="flex items-center gap-1">
      {#each nav as item (item.href)}
        <a
          href={item.href}
          class="rounded px-2.5 py-1 text-sm {page.url.pathname === item.href
            ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium'
            : 'text-[var(--color-muted)] hover:bg-gray-100'}"
        >
          {item.label}
        </a>
      {/each}
    </nav>

    <div class="ml-auto flex items-center gap-2">
      {#if app.busy}
        <span class="text-xs text-[var(--color-muted)]">working…</span>
      {/if}
      {#if gitChip}
        <span
          class="rounded px-2 py-0.5 text-xs {gitChip.tone === 'ok'
            ? 'bg-green-100 text-green-700'
            : gitChip.tone === 'warn'
              ? 'bg-amber-100 text-amber-700'
              : 'bg-gray-100 text-gray-500'}"
        >
          {gitChip.text}
        </span>
      {/if}
      {#if app.recordRoot}
        <button
          class="rounded border border-[var(--color-line)] px-2 py-1 text-xs hover:bg-gray-50"
          title={app.recordRoot}
          onclick={() => app.chooseFolder()}
        >
          📁 {folderName(app.recordRoot)}
        </button>
        <button
          class="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={app.busy}
          onclick={() => app.sync()}
        >
          Sync
        </button>
      {/if}
    </div>
  </header>

  <!-- Toast -->
  {#if app.error}
    <div class="border-b border-red-200 bg-red-50 px-4 py-1.5 text-sm text-red-700">{app.error}</div>
  {:else if app.message}
    <div class="border-b border-green-200 bg-green-50 px-4 py-1.5 text-sm text-green-700">
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
      <div class="mx-auto max-w-4xl p-4">
        {@render children()}
      </div>
    {/if}
  </main>
</div>
