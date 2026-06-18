<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { Profile } from '$lib/core';
  import Icon from '$lib/components/Icon.svelte';

  /** One editable identity row. `key` is a transient id so the {#each} stays
   *  stable while the user retypes a platform name. */
  type IdRow = { key: string; platform: string; url: string };

  // Well-known platforms pre-seeded (blank) on first run so the obvious prompts
  // still appear even before any identity exists (spec §4.2).
  const WELL_KNOWN = ['linkedin', 'github', 'website'];

  // Local editable copy, re-seeded whenever the loaded profile changes.
  let name = $state('');
  let headline = $state('');
  let location = $state('');
  let bio = $state('');
  let identities = $state<IdRow[]>([]);
  let loadedFor = $state<Profile | null>(null);
  let seq = 0;
  const row = (platform: string, url: string): IdRow => ({ key: String(seq++), platform, url });

  $effect(() => {
    const p = app.profile;
    if (p && p !== loadedFor) {
      loadedFor = p;
      const fm = p.frontmatter;
      name = (fm.name as string) ?? '';
      headline = (fm.headline as string) ?? '';
      location = (fm.location as string) ?? '';
      bio = p.body;
      const ids = (fm.identities as Record<string, string>) ?? {};
      const rows = Object.entries(ids).map(([k, v]) => row(k, v));
      // Pre-seed any absent well-known keys so first-run users get the prompts.
      for (const k of WELL_KNOWN) if (!(k in ids)) rows.push(row(k, ''));
      identities = rows;
    }
  });

  function addRow() {
    identities = [...identities, row('', '')];
  }
  function removeRow(key: string) {
    identities = identities.filter((r) => r.key !== key);
  }

  async function save() {
    const prev = app.profile?.frontmatter ?? {};
    // Rebuild identities from the rows: drop blanks, normalize platform keys to
    // match buildIdentityProposal (lowercase/trim); last write wins on dup keys.
    const ids: Record<string, string> = {};
    for (const r of identities) {
      const platform = r.platform.trim().toLowerCase();
      const url = r.url.trim();
      if (platform && url) ids[platform] = url;
    }
    const next: Profile = {
      frontmatter: {
        ...prev, // preserve unknown keys (profile.ts round-trip)
        name,
        headline,
        location,
        identities: ids
      },
      body: bio
    };
    await app.saveProfile(next);
  }
</script>

<div class="max-w-2xl space-y-3">
  <h1 class="text-lg font-semibold">Profile</h1>
  <p class="text-sm text-[var(--color-muted)]">
    Presentation-layer identity, edited freely. This seeds the resume and site headers.
  </p>

  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Name
      <input bind:value={name} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
    </label>
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Headline
      <input bind:value={headline} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
    </label>
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Location
      <input bind:value={location} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
    </label>
  </div>

  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-xs font-medium text-[var(--color-muted)]">Identities</span>
      <button
        class="flex items-center gap-1 rounded border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-hover)]"
        onclick={addRow}
      >
        <Icon name="plus" size={14} /> Add identity
      </button>
    </div>
    <p class="text-xs text-[var(--color-muted)]">
      Any platform you like — linkedin, github, twitter, vimeo, … Each becomes a link in the resume
      and site header.
    </p>
    {#each identities as r (r.key)}
      <div class="flex items-center gap-2">
        <input
          bind:value={r.platform}
          placeholder="platform"
          class="w-32 rounded border border-[var(--color-line)] px-2 py-1 text-sm"
        />
        <input
          bind:value={r.url}
          placeholder="https://…"
          class="flex-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm"
        />
        <button
          class="flex-none rounded border border-[var(--color-line)] p-1 text-[var(--color-muted)] hover:bg-[var(--color-hover)]"
          title="Remove"
          aria-label="Remove identity"
          onclick={() => removeRow(r.key)}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    {/each}
  </div>

  <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
    Bio (Markdown)
    <textarea bind:value={bio} rows="8" class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm"></textarea>
  </label>

  <div class="flex justify-end">
    <button
      class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      disabled={app.busy}
      onclick={save}>Save profile</button
    >
  </div>
</div>
