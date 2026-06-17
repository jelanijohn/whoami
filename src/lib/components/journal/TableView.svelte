<script lang="ts">
  import type { SvelteSet } from 'svelte/reactivity';
  import type { Entry, SortKey, SortDir } from '$lib/core';
  import { typeMeta, alpha } from '$lib/journal/theme';
  import { fmtShort } from '$lib/journal/grouping';

  let {
    entries,
    expandedEntries,
    ontoggleEntry,
    sortKey,
    sortDir,
    onsort,
    projectTitle,
    noResults,
    emptyMsg
  }: {
    entries: Entry[];
    expandedEntries: SvelteSet<string>;
    ontoggleEntry: (id: string) => void;
    sortKey: SortKey;
    sortDir: SortDir;
    onsort: (key: SortKey) => void;
    projectTitle: (slug: string) => string;
    noResults: boolean;
    emptyMsg: string;
  } = $props();

  const COLUMNS: { key: SortKey | 'tags'; label: string; sortable: boolean }[] = [
    { key: 'date', label: 'Date', sortable: true },
    { key: 'type', label: 'Type', sortable: true },
    { key: 'title', label: 'Title', sortable: true },
    { key: 'project', label: 'Project', sortable: true },
    { key: 'org', label: 'Org', sortable: true },
    { key: 'tags', label: 'Tags', sortable: false }
  ];

  const orgOf = (e: Entry) => (typeof e.frontmatter.org === 'string' ? (e.frontmatter.org as string) : '');
  const slugOf = (e: Entry) =>
    typeof e.frontmatter.project === 'string' ? (e.frontmatter.project as string) : '';
  const tagsOf = (e: Entry) => (Array.isArray(e.frontmatter.tags) ? (e.frontmatter.tags as string[]) : []);
</script>

<div class="mt-4 overflow-auto rounded-[14px] border border-[var(--color-line)] bg-white dark:bg-[var(--color-bar)]">
  <table class="w-full border-collapse text-[13px]" style="min-width:760px;">
    <thead>
      <tr class="bg-[var(--jv-row-detail)]">
        {#each COLUMNS as col (col.key)}
          {@const active = col.sortable && sortKey === col.key}
          <th
            onclick={() => col.sortable && onsort(col.key as SortKey)}
            class="whitespace-nowrap text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--color-muted)]"
            class:cursor-pointer={col.sortable}
            style="padding:10px 14px;"
          >
            {col.label}<span class="text-[var(--color-accent)]">{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
          </th>
        {/each}
      </tr>
    </thead>
    {#each entries as e (e.frontmatter.id)}
      {@const meta = typeMeta(String(e.frontmatter.type))}
      {@const slug = slugOf(e)}
      {@const tags = tagsOf(e)}
      {@const org = orgOf(e)}
      {@const expanded = expandedEntries.has(String(e.frontmatter.id))}
      <tbody>
        <tr onclick={() => ontoggleEntry(String(e.frontmatter.id))} class="cursor-pointer border-t border-[var(--jv-hair)]">
          <td class="whitespace-nowrap tabular-nums text-[var(--jv-date)]" style="padding:9px 14px;">{fmtShort(String(e.frontmatter.date))}</td>
          <td style="padding:9px 14px;">
            <span
              class="inline-block rounded-[6px] px-2 py-0.5 text-[11px] font-semibold"
              style="color:{meta.color};background:{alpha(meta.color, 10)};">{meta.label}</span
            >
          </td>
          <td class="truncate font-medium text-[var(--color-ink)]" style="padding:9px 14px;max-width:340px;">
            {e.frontmatter.title}{#if e.frontmatter.private}<span
                class="ml-[7px] rounded-[5px] bg-[var(--color-private)]/10 px-1.5 py-px text-[10px] font-semibold text-[var(--color-private)]"
                >private</span
              >{/if}
          </td>
          <td class="truncate whitespace-nowrap text-[var(--color-muted)]" style="padding:9px 14px;max-width:160px;"
            >{slug ? projectTitle(slug) : ''}</td
          >
          <td class="whitespace-nowrap text-[var(--jv-date)]" style="padding:9px 14px;">{org || '—'}</td>
          <td class="truncate whitespace-nowrap text-[var(--jv-date)]" style="padding:9px 14px;max-width:180px;"
            >{tags.length ? tags.map((t) => '#' + t).join(' ') : '—'}</td
          >
        </tr>
        {#if expanded}
          <tr class="bg-[var(--jv-row-detail)]">
            <td></td>
            <td colspan="5" style="padding:0 14px 13px;">
              <p class="m-0 whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--jv-body)]">{e.body}</p>
            </td>
          </tr>
        {/if}
      </tbody>
    {/each}
  </table>
  {#if noResults}
    <p class="py-12 text-center text-[13px] text-[var(--jv-date)]">{emptyMsg}</p>
  {/if}
</div>
