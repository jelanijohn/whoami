<script lang="ts">
  import { app } from '$lib/state.svelte';
  import CandidateCard from '$lib/components/CandidateCard.svelte';

  // Load the staged candidates whenever a record is open.
  $effect(() => {
    if (app.store) app.loadCandidates();
  });

  function promote(path: string, project: string) {
    void app.promoteCandidate(path, project);
  }
  function reject(path: string, title: string) {
    if (confirm(`Reject “${title}”? It won't be proposed again.`)) {
      void app.rejectCandidate(path, title);
    }
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
      {app.candidates.length} candidate{app.candidates.length === 1 ? '' : 's'} awaiting review
    </p>
    <div class="space-y-3">
      {#each app.candidates as candidate (candidate.path)}
        <CandidateCard
          {candidate}
          projects={app.projects}
          busy={app.busy}
          onpromote={promote}
          onreject={reject}
        />
      {/each}
    </div>
  {/if}
</div>
