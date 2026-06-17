<script lang="ts">
  import type { SvelteSet } from 'svelte/reactivity';
  import type { Entry } from '$lib/core';
  import type { DayGroup } from '$lib/journal/grouping';
  import JournalEntryRow from './JournalEntryRow.svelte';

  let {
    days,
    expandedEntries,
    ontoggleEntry,
    projectTitle,
    onedit,
    ondelete,
    noResults,
    emptyMsg
  }: {
    days: DayGroup[];
    expandedEntries: SvelteSet<string>;
    ontoggleEntry: (id: string) => void;
    projectTitle: (slug: string) => string;
    onedit?: (e: Entry) => void;
    ondelete?: (e: Entry) => void;
    noResults: boolean;
    emptyMsg: string;
  } = $props();
</script>

<div class="mt-[18px] pl-1.5">
  {#each days as d (d.key)}
    <div class="relative border-l-2 border-[var(--jv-rail)] pb-1.5 pl-[26px]">
      <span
        class="absolute left-[-7px] top-[3px] size-3 rounded-full border-2 border-[var(--color-accent)] bg-white dark:bg-[var(--color-paper)]"
      ></span>
      <div class="flex items-baseline gap-[9px] pb-[5px]">
        <span class="text-[13px] font-semibold text-[var(--color-ink)]">{d.label}</span>
        <span class="text-[11px] text-[var(--jv-faint)]"
          >{d.entries.length} {d.entries.length === 1 ? 'entry' : 'entries'}</span
        >
      </div>
      <div class="flex flex-col gap-1 pb-[14px]">
        {#each d.entries as entry (entry.frontmatter.id)}
          <div class="overflow-hidden rounded-[9px] border border-[var(--jv-rail)] bg-white dark:bg-[var(--color-bar)]">
            <JournalEntryRow
              {entry}
              variant="timeline"
              expanded={expandedEntries.has(String(entry.frontmatter.id))}
              ontoggle={() => ontoggleEntry(String(entry.frontmatter.id))}
              {projectTitle}
              {onedit}
              {ondelete}
            />
          </div>
        {/each}
      </div>
    </div>
  {/each}
  {#if noResults}
    <p class="py-12 text-center text-[13px] text-[var(--jv-date)]">{emptyMsg}</p>
  {/if}
</div>
