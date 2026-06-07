import { defineConfig } from 'vitest/config';

// The core is framework-agnostic and tested against node-backed platform
// implementations — no SvelteKit/Tauri/browser needed. Keeping a dedicated
// Vitest config avoids loading the SvelteKit plugin (which would require a
// `svelte-kit sync`) just to run pure-TypeScript tests.
export default defineConfig({
  test: {
    include: ['src/lib/core/**/*.test.ts'],
    environment: 'node'
  }
});
