<script lang="ts">
  import type { SvelteSet } from 'svelte/reactivity';
  import type { Entry } from '$lib/core';
  import { dateRange, type JournalGroup } from '$lib/journal/grouping';
  import JournalEntryRow from './JournalEntryRow.svelte';

  let {
    groups,
    expandedGroups,
    expandedEntries,
    ontoggleGroup,
    ontoggleEntry,
    projectTitle,
    onedit,
    ondelete,
    noResults,
    emptyMsg
  }: {
    groups: JournalGroup[];
    expandedGroups: SvelteSet<string>;
    expandedEntries: SvelteSet<string>;
    ontoggleGroup: (key: string) => void;
    ontoggleEntry: (id: string) => void;
    projectTitle: (slug: string) => string;
    onedit?: (e: Entry) => void;
    ondelete?: (e: Entry) => void;
    noResults: boolean;
    emptyMsg: string;
  } = $props();
</script>

<div class="mt-4 flex flex-col gap-[9px]">
  {#each groups as g (g.key)}
    {@const open = expandedGroups.has(g.key)}
    <div class="overflow-hidden rounded-[14px] border border-[var(--color-line)] bg-white dark:bg-[var(--color-bar)]">
      <button
        onclick={() => ontoggleGroup(g.key)}
        class="flex w-full items-center gap-[11px] border-none bg-transparent px-4 py-[13px] text-left"
      >
        <span
          class="jv-chevron shrink-0 text-[17px] text-[var(--jv-chevron)] transition-transform duration-150 ease-out"
          style="transform:rotate({open ? 90 : 0}deg)">›</span
        >
        <span class="size-[10px] shrink-0 rounded-[3px]" style="background:{g.color}"></span>
        <span class="text-[14px] font-semibold text-[var(--color-ink)]">{g.label}</span>
        <span class="text-[12px] text-[var(--jv-date)]"
          >{g.entries.length}
          {g.entries.length === 1 ? 'entry' : 'entries'}&nbsp;&nbsp;·&nbsp;&nbsp;{dateRange(g.entries)}</span
        >
        <span
          class="ml-auto rounded-full bg-[var(--jv-chip-bg)] px-[9px] py-0.5 text-[12px] font-semibold tabular-nums text-[var(--color-muted)]"
          >{g.entries.length}</span
        >
      </button>
      {#if open}
        <div class="border-t border-[var(--jv-hair)]">
          {#each g.entries as entry (entry.frontmatter.id)}
            <div class="border-t border-[var(--jv-hair-soft)]">
              <JournalEntryRow
                {entry}
                variant="grouped"
                expanded={expandedEntries.has(String(entry.frontmatter.id))}
                ontoggle={() => ontoggleEntry(String(entry.frontmatter.id))}
                {projectTitle}
                {onedit}
                {ondelete}
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  {#if noResults}
    <p class="py-12 text-center text-[13px] text-[var(--jv-date)]">{emptyMsg}</p>
  {/if}
</div>
