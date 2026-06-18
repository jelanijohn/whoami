<script lang="ts">
  import type { Entry, ProjectSummary } from '$lib/core';
  import Icon from '$lib/components/Icon.svelte';
  import { typeMeta, sourceMeta, alpha, KEPT_COLOR, FLAGGED_COLOR } from '$lib/inbox/theme';
  import { changeSizeOf, isFrivolous, relativeDate, tagsOf } from '$lib/inbox/grouping';

  let {
    candidate,
    projects,
    busy = false,
    selected = false,
    expanded = false,
    compact = false,
    project,
    onselect,
    ontoggle,
    onprojectchange,
    onpromote,
    onreject
  }: {
    candidate: Entry;
    projects: ProjectSummary[];
    busy?: boolean;
    selected?: boolean;
    expanded?: boolean;
    /** Compact density tightens the row padding (handoff §5). */
    compact?: boolean;
    /** Current per-item project value (owned by the page, seeded from the
     * suggestion) — bound through `onprojectchange` so promote reads one source. */
    project: string;
    onselect: (path: string, checked: boolean) => void;
    ontoggle: () => void;
    onprojectchange: (path: string, slug: string) => void;
    onpromote: (path: string, project: string) => void;
    onreject: (path: string, title: string) => void;
  } = $props();

  const fm = $derived(candidate.frontmatter);
  const path = $derived(candidate.path ?? '');
  const title = $derived(typeof fm.title === 'string' ? fm.title : '');
  const tmeta = $derived(typeMeta(String(fm.type)));
  const src = $derived(typeof fm.source === 'string' ? fm.source : '');
  const smeta = $derived(src ? sourceMeta(src) : null);
  const sourceUrl = $derived(typeof fm.source_url === 'string' ? fm.source_url : '');
  const changeSize = $derived(changeSizeOf(candidate));
  const friv = $derived(isFrivolous(candidate));
  const triageReason = $derived(typeof fm.triage_reason === 'string' ? fm.triage_reason : '');
  const triageBy = $derived(fm.triage_source === 'llm' ? 'model' : 'prefilter');
  const tags = $derived(tagsOf(candidate));
  const excerpt = $derived(
    candidate.body.length > 280 ? candidate.body.slice(0, 280).trimEnd() + '…' : candidate.body
  );
  // A slug suggested by the adapter that isn't a real project yet still shows as
  // an option so the picker can keep the suggestion as the promote value.
  const suggested = $derived(typeof fm.project === 'string' ? fm.project : '');
  const suggestedOrphan = $derived(suggested !== '' && !projects.some((p) => p.slug === suggested));

  // Stop the row's expand-toggle from firing when interacting with controls.
  const stop = (fn: () => void) => (e: Event) => {
    e.stopPropagation();
    fn();
  };
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="flex cursor-pointer items-center gap-2.5"
  style="padding:{compact ? '8px 14px' : '11px 15px'};{friv
    ? 'background:rgba(192,122,0,0.03);'
    : ''}"
  role="button"
  tabindex="0"
  aria-expanded={expanded}
  onclick={ontoggle}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ontoggle();
    }
  }}
>
  <!-- Selection checkbox -->
  <button
    type="button"
    aria-label="Select “{title}”"
    aria-pressed={selected}
    onclick={stop(() => onselect(path, !selected))}
    class="grid size-[17px] shrink-0 place-items-center rounded-[5px] transition-all duration-100"
    style={selected
      ? 'background:var(--color-accent);border:1px solid var(--color-accent);'
      : 'background:white;border:1.5px solid var(--color-edge);'}
  >
    <span class="text-white transition-opacity duration-100" style="opacity:{selected ? 1 : 0}">
      <Icon name="check" size={13} strokeWidth={3} />
    </span>
  </button>

  <!-- Type pill -->
  <span
    class="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold"
    style="color:{tmeta.color};background:{alpha(tmeta.color, 10)}">{fm.type}</span
  >

  <!-- Title -->
  <span
    class="min-w-0 flex-1 truncate text-[13.5px] font-medium"
    style="color:{friv ? '#8a8a86' : 'var(--color-ink)'}">{title}</span
  >

  <!-- Source badge -->
  {#if smeta}
    <span
      class="inline-flex shrink-0 items-center gap-[5px] rounded-md px-2 py-0.5 text-[11px] font-medium"
      style="color:{smeta.color};background:{alpha(smeta.color, 8)}"
    >
      <Icon name={smeta.glyph} size={13} />
      {smeta.label}
    </span>
  {/if}

  <!-- Change-size badge -->
  {#if changeSize}
    <span class="shrink-0 font-mono text-[11px]" title="{changeSize.additions} additions, {changeSize.deletions} deletions">
      <span style="color:{KEPT_COLOR}">+{changeSize.additions}</span>
      <span class="text-[#c5331f]">−{changeSize.deletions}</span>
    </span>
  {/if}

  <!-- Frivolous badge -->
  {#if friv}
    <span
      class="shrink-0 rounded-[5px] px-[7px] py-0.5 text-[10px] font-semibold"
      style="color:{FLAGGED_COLOR};background:rgba(192,122,0,0.12)">frivolous</span
    >
  {/if}

  <!-- Relative date -->
  <span class="w-[62px] shrink-0 text-right text-[11px] tabular-nums text-[var(--jv-faint)]"
    >{relativeDate(String(fm.date))}</span
  >

  <!-- Quick promote -->
  <button
    type="button"
    title="Promote"
    aria-label="Promote “{title}”"
    disabled={busy}
    onclick={stop(() => onpromote(path, project))}
    class="grid size-7 shrink-0 place-items-center rounded-[7px] disabled:opacity-50"
    style="background:rgba(31,158,111,0.1);color:{KEPT_COLOR}"
  >
    <Icon name="check_circle" size={17} />
  </button>

  <!-- Quick reject -->
  <button
    type="button"
    title="Reject"
    aria-label="Reject “{title}”"
    disabled={busy}
    onclick={stop(() => onreject(path, title))}
    class="grid size-7 shrink-0 place-items-center rounded-[7px] text-[var(--color-private)] disabled:opacity-50"
    style="background:rgba(181,71,8,0.08)"
  >
    <Icon name="cancel" size={17} />
  </button>

  <!-- Expand chevron -->
  <span
    class="jv-chevron shrink-0 text-[var(--jv-chevron)] transition-transform duration-150 ease-out"
    style="transform:rotate({expanded ? 180 : 0}deg)"
  >
    <Icon name="expand_more" size={19} />
  </span>
</div>

{#if expanded}
  <div class="jv-rise" style="padding:2px 16px 15px 44px;">
    {#if excerpt.trim()}
      <p class="m-0 whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--jv-body)]">{excerpt}</p>
    {/if}

    {#if friv}
      <p class="mt-2 mb-0 flex items-start gap-1.5 text-[11.5px]" style="color:{FLAGGED_COLOR}">
        <span class="mt-px shrink-0"><Icon name="info" size={15} /></span>
        <span
          >Flagged as frivolous by the {triageBy}{triageReason ? ` — ${triageReason}` : ''}. Promote and
          reject still work; this is only a sort hint.</span
        >
      </p>
    {/if}

    {#if tags.length}
      <div class="mt-2 flex flex-wrap gap-[5px]">
        {#each tags as tag (tag)}
          <span class="rounded-md bg-[var(--jv-chip-bg)] px-[7px] py-0.5 text-[11px] text-[var(--color-muted)]"
            >#{tag}</span
          >
        {/each}
      </div>
    {/if}

    <div
      class="mt-3 flex flex-wrap items-center gap-[9px] border-t border-[var(--jv-hair)] pt-3"
    >
      {#if sourceUrl}
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline"
        >
          View source <Icon name="open_in_new" size={13} />
        </a>
      {/if}
      {#if changeSize}
        <span class="font-mono text-[11px] text-[var(--color-muted)]">
          <span style="color:{KEPT_COLOR}">+{changeSize.additions}</span>
          <span class="text-[#c5331f]">−{changeSize.deletions}</span>
          · {changeSize.changedFiles} file{changeSize.changedFiles === 1 ? '' : 's'}
        </span>
      {/if}

      <div class="ml-auto flex items-center gap-[9px]">
        <label class="text-[11px] uppercase tracking-[0.04em] text-[var(--jv-date)]" for="proj-{fm.id}"
          >Project</label
        >
        <select
          id="proj-{fm.id}"
          value={project}
          onchange={(e) => onprojectchange(path, e.currentTarget.value)}
          class="h-[30px] rounded-lg border border-[var(--color-line)] bg-white px-2 text-[13px] text-[var(--color-ink)] dark:bg-[var(--color-bar)]"
        >
          <option value="">— none —</option>
          {#each projects as p (p.slug)}
            <option value={p.slug}>{p.entry.frontmatter.title}</option>
          {/each}
          {#if suggestedOrphan}
            <option value={suggested}>{suggested} (suggested)</option>
          {/if}
        </select>
        <button
          type="button"
          disabled={busy}
          onclick={() => onreject(path, title)}
          class="h-[30px] rounded-lg border px-3 text-[12px] font-semibold text-[var(--color-private)] disabled:opacity-50"
          style="border-color:#ecc9b9"
        >
          Reject
        </button>
        <button
          type="button"
          disabled={busy}
          onclick={() => onpromote(path, project)}
          class="h-[30px] rounded-lg bg-[var(--color-accent)] px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Promote
        </button>
      </div>
    </div>
  </div>
{/if}
