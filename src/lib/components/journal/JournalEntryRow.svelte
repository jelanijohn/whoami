<script lang="ts">
  import type { Entry } from '$lib/core';
  import { typeMeta } from '$lib/journal/theme';
  import { fmtShort, fmtDay } from '$lib/journal/grouping';

  let {
    entry,
    expanded,
    ontoggle,
    variant,
    projectTitle,
    onedit,
    ondelete
  }: {
    entry: Entry;
    expanded: boolean;
    ontoggle: () => void;
    /** `grouped` adds a date column + chevron and a meta line; `timeline`
     * leads with a type dot and omits both (the day header carries the date). */
    variant: 'grouped' | 'timeline';
    projectTitle: (slug: string) => string;
    /** Optional edit/remove actions, surfaced in the expanded body so the
     * timeline keeps the CRUD it had before the redesign. */
    onedit?: (e: Entry) => void;
    ondelete?: (e: Entry) => void;
  } = $props();

  const fm = $derived(entry.frontmatter);
  const meta = $derived(typeMeta(String(fm.type)));
  const date = $derived(String(fm.date));
  const tags = $derived(Array.isArray(fm.tags) ? (fm.tags as string[]) : []);
  const org = $derived(typeof fm.org === 'string' ? fm.org : '');
  const projectSlug = $derived(typeof fm.project === 'string' ? (fm.project as string) : '');
  const projectLabel = $derived(projectSlug ? projectTitle(projectSlug) : '');
  const metaLine = $derived.by(() => {
    const parts: string[] = [];
    if (org) parts.push(org);
    parts.push(fmtDay(date));
    if (projectSlug) parts.push('project: ' + projectLabel);
    return parts.join('  ·  ');
  });
</script>

<button
  onclick={ontoggle}
  class="flex w-full items-center gap-2.5 border-none bg-transparent text-left"
  style={variant === 'grouped' ? 'padding:9px 16px 9px 40px;' : 'padding:8px 12px;'}
>
  {#if variant === 'grouped'}
    <span class="w-[84px] shrink-0 text-[11px] tabular-nums text-[var(--jv-date)]">{fmtShort(date)}</span>
    <span class="w-[74px] shrink-0 text-[11px] font-semibold" style="color:{meta.color}">{meta.label}</span>
  {:else}
    <span class="size-[7px] shrink-0 rounded-[2px]" style="background:{meta.color}"></span>
    <span class="w-[72px] shrink-0 text-[11px] font-semibold" style="color:{meta.color}">{meta.label}</span>
  {/if}
  <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-ink)]">{fm.title}</span>
  {#if fm.private}
    <span
      class="shrink-0 rounded-[5px] bg-[var(--color-private)]/10 px-1.5 py-px text-[10px] font-semibold text-[var(--color-private)]"
      >private</span
    >
  {/if}
  {#if projectLabel}
    <span
      class="shrink-0 truncate text-[11px] text-[var(--jv-faint)]"
      style={variant === 'grouped' ? 'max-width:160px;' : 'max-width:150px;'}>{projectLabel}</span
    >
  {/if}
  {#if variant === 'grouped'}
    <span
      class="jv-chevron shrink-0 text-[15px] text-[var(--jv-chevron)] transition-transform duration-150 ease-out"
      style="transform:rotate({expanded ? 90 : 0}deg)">›</span
    >
  {/if}
</button>

{#if expanded}
  <div class="jv-rise" style={variant === 'grouped' ? 'padding:2px 18px 14px 40px;' : 'padding:0 14px 12px;'}>
    {#if entry.body.trim()}
      <p class="m-0 whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--jv-body)]">{entry.body}</p>
    {/if}
    {#if tags.length}
      <div class="mt-2 flex flex-wrap gap-[5px]">
        {#each tags as tag (tag)}
          <span class="rounded-[6px] bg-[var(--jv-chip-bg)] px-[7px] py-0.5 text-[11px] text-[var(--color-muted)]"
            >#{tag}</span
          >
        {/each}
      </div>
    {/if}
    {#if variant === 'grouped'}
      <p class="mt-2 mb-0 text-[11px] text-[var(--jv-faint)]">{metaLine}</p>
    {/if}
    {#if onedit || ondelete}
      <div class="mt-2 flex gap-3">
        {#if onedit}
          <button class="text-[11px] text-[var(--color-muted)] hover:underline" onclick={() => onedit?.(entry)}
            >Edit</button
          >
        {/if}
        {#if ondelete}
          <button class="text-[11px] text-[var(--color-private)] hover:underline" onclick={() => ondelete?.(entry)}
            >Remove</button
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}
