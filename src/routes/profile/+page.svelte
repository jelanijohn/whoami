<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { Profile } from '$lib/core';

  // Local editable copy, re-seeded whenever the loaded profile changes.
  let name = $state('');
  let headline = $state('');
  let location = $state('');
  let linkedin = $state('');
  let github = $state('');
  let website = $state('');
  let bio = $state('');
  let loadedFor = $state<Profile | null>(null);

  $effect(() => {
    const p = app.profile;
    if (p && p !== loadedFor) {
      loadedFor = p;
      const fm = p.frontmatter;
      name = (fm.name as string) ?? '';
      headline = (fm.headline as string) ?? '';
      location = (fm.location as string) ?? '';
      const ids = (fm.identities as Record<string, string>) ?? {};
      linkedin = ids.linkedin ?? '';
      github = ids.github ?? '';
      website = ids.website ?? '';
      bio = p.body;
    }
  });

  async function save() {
    const prev = app.profile?.frontmatter ?? {};
    const prevIds = (prev.identities as Record<string, string>) ?? {};
    const next: Profile = {
      frontmatter: {
        ...prev, // preserve unknown keys (spec §3 round-trip)
        name,
        headline,
        location,
        identities: { ...prevIds, linkedin, github, website }
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
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      LinkedIn
      <input bind:value={linkedin} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
    </label>
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      GitHub
      <input bind:value={github} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
    </label>
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Website
      <input bind:value={website} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
    </label>
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
