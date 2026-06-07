<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { ENTRY_TYPES, type Entry } from '$lib/core';
  import EntryCard from '$lib/components/EntryCard.svelte';
  import EntryEditor from '$lib/components/EntryEditor.svelte';

  let mode = $state<'idle' | 'new'>('idle');
  let editing = $state<Entry | null>(null);

  function startNew() {
    editing = null;
    mode = 'new';
  }
  function startEdit(e: Entry) {
    editing = e;
    mode = 'idle';
  }
  function done() {
    mode = 'idle';
    editing = null;
  }

  async function remove(e: Entry) {
    if (confirm(`Remove “${e.frontmatter.title}”? It stays in Git history.`)) {
      await app.deleteEntry(e);
    }
  }

  // Re-query whenever a filter changes.
  let t: ReturnType<typeof setTimeout> | undefined;
  function onFilter() {
    clearTimeout(t);
    t = setTimeout(() => app.refresh(), 150);
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-2">
    <input
      bind:value={app.search}
      oninput={onFilter}
      placeholder="Search the timeline…"
      class="flex-1 rounded border border-[var(--color-line)] px-3 py-1.5 text-sm"
    />
    <select
      bind:value={app.filterType}
      onchange={onFilter}
      class="rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
    >
      <option value="">all types</option>
      {#each ENTRY_TYPES as t (t)}
        <option value={t}>{t}</option>
      {/each}
    </select>
    <label class="flex items-center gap-1.5 text-sm text-[var(--color-muted)]">
      <input type="checkbox" bind:checked={app.includePrivate} onchange={onFilter} />
      show private
    </label>
    <button
      class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
      onclick={startNew}
    >
      + Add entry
    </button>
  </div>

  {#if mode === 'new'}
    <EntryEditor entry={null} ondone={done} />
  {/if}

  {#if app.entries.length === 0}
    <p class="py-12 text-center text-sm text-[var(--color-muted)]">
      Nothing here yet. Capture the truth as it happens — add your first entry.
    </p>
  {:else}
    <div class="space-y-3">
      {#each app.entries as entry (entry.frontmatter.id)}
        {#if editing && editing.frontmatter.id === entry.frontmatter.id}
          <EntryEditor {entry} ondone={done} />
        {:else}
          <EntryCard {entry} onedit={startEdit} ondelete={remove} />
        {/if}
      {/each}
    </div>
  {/if}
</div>
