import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Tauri serves a static SPA bundle; no Node server at runtime.
    adapter: adapter({
      fallback: 'index.html'
    }),
    // The desktop app is a single-page app — disable SSR everywhere.
    prerender: { entries: [] }
  }
};

export default config;
