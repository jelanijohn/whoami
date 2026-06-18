<script lang="ts">
  /**
   * Identity-merge review (profile-merge spec §5). Renders the pending proposal
   * as a checkbox list and merges only the ticked rows via the accept gate.
   * Nothing is written to the profile until the user ticks + applies — the
   * producer only proposed.
   */
  import { app } from '$lib/state.svelte';
  import type { IdentityProposal } from '$lib/core';
  import Icon from '$lib/components/Icon.svelte';

  let { proposal }: { proposal: IdentityProposal } = $props();

  // Per-row checked state, seeded from status whenever the proposal changes:
  // 'new' checked by default, 'conflict' unchecked (replacing is opt-in).
  let checked = $state<Record<string, boolean>>({});
  let seededFor = $state<IdentityProposal | null>(null);
  $effect(() => {
    if (proposal !== seededFor) {
      seededFor = proposal;
      const next: Record<string, boolean> = {};
      for (const r of proposal.rows) if (r.status !== 'present') next[r.platform] = r.status === 'new';
      checked = next;
    }
  });

  const selected = $derived(
    proposal.rows
      .filter((r) => r.status !== 'present' && checked[r.platform])
      .reduce<Record<string, string>>((acc, r) => ((acc[r.platform] = r.url), acc), {})
  );
  const anyTicked = $derived(Object.keys(selected).length > 0);

  async function apply() {
    await app.applyIdentityMerge(selected);
  }
</script>

<div class="space-y-3 rounded border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
  <div class="space-y-1">
    <h3 class="text-sm font-semibold">Identities found on your site</h3>
    <p class="text-xs text-[var(--color-muted)]">
      These outbound links came from your own website. They're added to your profile only when you
      apply — nothing has been written yet.
    </p>
  </div>

  <ul class="space-y-1.5">
    {#each proposal.rows as r (r.platform)}
      {#if r.status === 'present'}
        <li class="flex items-center gap-2 text-xs text-[var(--color-muted)] opacity-60">
          <span class="w-3.5 flex-none"></span>
          <span class="w-20 flex-none font-medium">{r.platform}</span>
          <span class="truncate">{r.url}</span>
          <span class="flex-none italic">already on your profile</span>
        </li>
      {:else}
        <li class="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            bind:checked={checked[r.platform]}
            class="mt-0.5 flex-none"
            id="id-{r.platform}"
          />
          <label for="id-{r.platform}" class="flex flex-1 flex-col gap-0.5">
            <span class="flex items-center gap-2">
              <span class="w-20 flex-none font-medium">{r.platform}</span>
              {#if r.status === 'new'}
                <span class="truncate">{r.url}</span>
              {:else}
                <span class="truncate">
                  <span class="text-[var(--color-muted)] line-through">{r.existingUrl}</span>
                  <span class="px-1">→</span>
                  <span>{r.url}</span>
                </span>
              {/if}
            </span>
            {#if r.status === 'conflict'}
              <span class="text-[var(--color-private)]">Ticking replaces the current value.</span>
            {/if}
          </label>
        </li>
      {/if}
    {/each}
  </ul>

  <div class="flex items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
    <button
      class="flex items-center gap-1 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      disabled={!anyTicked || app.busy}
      onclick={apply}
    >
      <Icon name="check_circle" size={16} /> Add selected to profile
    </button>
    <button
      class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:bg-[var(--color-hover)] disabled:opacity-50"
      disabled={app.busy}
      onclick={() => app.dismissIdentityProposal()}
    >
      Dismiss
    </button>
  </div>
</div>
