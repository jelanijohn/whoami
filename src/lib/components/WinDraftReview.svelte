<script lang="ts">
  /**
   * Wins draft review (wins-from-journal spec §6.2). Renders the LLM's drafted
   * wins as editable rows gated by a human accept step. Each kept+edited row
   * becomes an {@link AcceptedWin} carrying its own evidence and its own date
   * (seeded from the latest of that draft's cited sources), plus the shared
   * parent / privacy choice. Nothing is written until the human accepts —
   * the producer (draftWins) only proposed.
   */
  import { app } from '$lib/state.svelte';
  import { id6, type WinProposal, type AcceptedWin } from '$lib/core';
  import Icon from '$lib/components/Icon.svelte';

  let {
    proposal,
    targets,
    onaccept,
    oncancel
  }: {
    proposal: WinProposal;
    targets: { id: string; label: string; kind: 'role' | 'project' }[];
    onaccept: (accepted: AcceptedWin[]) => void;
    oncancel: () => void;
  } = $props();

  // Per-row editable text + date + keep flag, seeded whenever the proposal
  // changes. Each date seeds from the latest of THAT draft's cited sources.
  let texts = $state<string[]>([]);
  let dates = $state<string[]>([]);
  let kept = $state<boolean[]>([]);
  let seededFor = $state<WinProposal | null>(null);
  // Shared attachment / privacy, applied to every kept win (spec §6.2).
  let parent = $state('');
  let keepPrivate = $state(false);
  $effect(() => {
    if (proposal !== seededFor) {
      seededFor = proposal;
      texts = proposal.drafts.map((d) => d.text);
      dates = proposal.drafts.map((d) => d.defaultDate);
      kept = proposal.drafts.map(() => true);
      parent = '';
      keepPrivate = false;
    }
  });

  // id → title, for showing each cited source's provenance (spec §6.2).
  const titleById = $derived(
    new Map(app.entries.map((e) => [String(e.frontmatter.id), String(e.frontmatter.title)]))
  );
  const sourceLabel = (id: string) => `${id6(id)} · ${titleById.get(id) ?? '(unknown)'}`;

  const roles = $derived(targets.filter((t) => t.kind === 'role'));
  const projects = $derived(targets.filter((t) => t.kind === 'project'));

  const isValidDate = (d: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test((d ?? '').trim());
  const saving = $derived(kept.map((k, i) => k && !!texts[i]?.trim()));
  const anyKept = $derived(saving.some(Boolean));
  const datesValid = $derived(saving.every((s, i) => !s || isValidDate(dates[i])));
  const canSave = $derived(anyKept && datesValid && !app.busy);

  function accept() {
    const accepted: AcceptedWin[] = proposal.drafts
      .map((d, i) => ({ d, i }))
      .filter(({ i }) => saving[i])
      .map(({ d, i }) => ({
        text: texts[i].trim(),
        evidence: d.evidence,
        parent: parent || undefined,
        date: dates[i].trim(),
        private: keepPrivate
      }));
    onaccept(accepted);
  }
</script>

<div class="space-y-3 rounded border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
  <div class="space-y-1">
    <h3 class="text-sm font-semibold">Draft wins for your résumé</h3>
    <p class="text-xs text-[var(--color-muted)]">
      LLM-assisted. Each win cites the entries it was drawn from. Statements are reframed as impact —
      proprietary detail (names, exact figures, verbatim text) is intentionally not copied. Nothing
      is saved until you accept.
    </p>
  </div>

  {#if proposal.drafts.length === 0}
    <p class="text-xs text-[var(--color-muted)]">
      The model didn't draft anything it could ground in your selection — try selecting more detailed
      entries.
    </p>
    <div class="flex items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
      <button
        class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:bg-[var(--color-hover)]"
        onclick={oncancel}
      >
        Close
      </button>
    </div>
  {:else}
    <ul class="space-y-3">
      {#each proposal.drafts as draft, i (i)}
        <li class="flex items-start gap-2">
          <input type="checkbox" bind:checked={kept[i]} class="mt-1.5 flex-none" id="win-{i}" />
          <div class="flex flex-1 flex-col gap-1">
            <textarea
              bind:value={texts[i]}
              rows="2"
              class="w-full rounded border border-[var(--color-line)] px-2 py-1 text-sm"
              class:opacity-50={!kept[i]}
            ></textarea>
            <div class="flex flex-wrap gap-1.5 text-[11px] text-[var(--color-muted)]">
              <span>From:</span>
              {#each draft.evidence as id (id)}
                <span class="rounded bg-[var(--color-hover)] px-1.5 py-0.5">{sourceLabel(id)}</span>
              {/each}
            </div>
            <label
              class="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]"
              class:opacity-50={!kept[i]}
            >
              <span class="font-medium">Date</span>
              <input
                type="date"
                bind:value={dates[i]}
                disabled={!kept[i]}
                class="rounded border border-[var(--color-line)] px-1.5 py-0.5 text-xs"
              />
              <span>Latest of this win's cited entries — it never invents one.</span>
            </label>
          </div>
        </li>
      {/each}
    </ul>

    <div class="border-t border-dashed border-[var(--color-line)] pt-3">
      <label class="flex flex-col gap-1 text-xs sm:max-w-[50%]">
        <span class="font-medium">Attach to</span>
        <select
          bind:value={parent}
          class="rounded border border-[var(--color-line)] px-2 py-1 text-sm"
        >
          <option value="">— None (Highlights) —</option>
          {#if roles.length}
            <optgroup label="Roles">
              {#each roles as t (t.id)}
                <option value={t.id}>{t.label}</option>
              {/each}
            </optgroup>
          {/if}
          {#if projects.length}
            <optgroup label="Projects">
              {#each projects as t (t.id)}
                <option value={t.id}>{t.label}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
        <span class="text-[var(--color-muted)]">Applies to every kept win.</span>
      </label>
    </div>

    <label class="flex items-start gap-2 text-xs">
      <input type="checkbox" bind:checked={keepPrivate} class="mt-0.5 flex-none" />
      <span class="flex flex-col gap-0.5">
        <span class="font-medium">Keep private</span>
        <span class="text-[var(--color-muted)]">
          Wins are public by default so they appear in your résumé and site.
        </span>
      </span>
    </label>

    <div class="flex items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
      <button
        class="flex items-center gap-1 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        disabled={!canSave}
        onclick={accept}
      >
        <Icon name="check_circle" size={16} /> Accept &amp; save
      </button>
      <button
        class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:bg-[var(--color-hover)] disabled:opacity-50"
        disabled={app.busy}
        onclick={oncancel}
      >
        Discard
      </button>
      {#if !datesValid}
        <span class="text-[11px] text-[var(--color-private)]">Every kept win needs a valid date.</span>
      {/if}
    </div>
  {/if}
</div>
