<script lang="ts">
  import type { Entry } from '$lib/core';
  import { app } from '$lib/state.svelte';
  import CandidateCard from '$lib/components/CandidateCard.svelte';

  // Load the staged candidates whenever a record is open.
  $effect(() => {
    if (app.store) app.loadCandidates();
  });

  // Triage (spec §6): a `frivolous` signal collapses an item into a disclosure;
  // it is never removed. Absence ⇒ untriaged ⇒ treated as keep.
  const isFrivolous = (c: Entry) => c.frontmatter.triage_signal === 'frivolous';
  const kept = $derived(app.candidates.filter((c) => !isFrivolous(c)));
  const frivolous = $derived(app.candidates.filter(isFrivolous));

  function promote(path: string, project: string) {
    void app.promoteCandidate(path, project);
  }
  function reject(path: string, title: string) {
    if (confirm(`Reject “${title}”? It won't be proposed again.`)) {
      void app.rejectCandidate(path, title);
    }
  }
  async function rejectAllFrivolous() {
    if (!confirm(`Reject all ${frivolous.length} item(s) flagged as frivolous? They won't be proposed again.`)) {
      return;
    }
    // A human click, never automatic — reuses the existing per-item reject gate.
    for (const c of frivolous) await app.rejectCandidate(c.path!, String(c.frontmatter.title));
  }
</script>

<div class="space-y-4">
  <section>
    <h1 class="text-lg font-semibold">Ingest inbox</h1>
    <p class="mt-1 text-sm text-[var(--color-muted)]">
      Candidates fetched from your data sources, staged for review. Nothing here is part of your
      record yet — promote to add it (assigning a project), or reject to dismiss it for good. Raw,
      verbatim, private by default.
    </p>
  </section>

  {#if app.candidates.length === 0}
    <p class="py-12 text-center text-sm text-[var(--color-muted)]">
      The inbox is empty. Run a data-source import to stage candidates here.
    </p>
  {:else}
    <p class="text-xs text-[var(--color-muted)]">
      {app.candidates.length} candidate{app.candidates.length === 1 ? '' : 's'} awaiting review{#if frivolous.length}
        · {kept.length} kept, {frivolous.length} flagged frivolous{/if}
    </p>

    <div class="space-y-3">
      {#each kept as candidate (candidate.path)}
        <CandidateCard
          {candidate}
          projects={app.projects}
          busy={app.busy}
          onpromote={promote}
          onreject={reject}
        />
      {/each}
    </div>

    {#if frivolous.length}
      <details class="rounded-lg border border-[var(--color-line)] bg-gray-50 dark:bg-white/5">
        <summary class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm text-[var(--color-muted)]">
          Show {frivolous.length} flagged as frivolous
          <button
            class="ml-auto rounded px-2 py-0.5 text-xs text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
            disabled={app.busy}
            onclick={(e) => {
              e.preventDefault();
              void rejectAllFrivolous();
            }}
          >
            Reject all {frivolous.length}
          </button>
        </summary>
        <div class="space-y-3 p-3 pt-0">
          {#each frivolous as candidate (candidate.path)}
            <CandidateCard
              {candidate}
              projects={app.projects}
              busy={app.busy}
              onpromote={promote}
              onreject={reject}
            />
          {/each}
        </div>
      </details>
    {/if}
  {/if}
</div>
