import { defineConfig } from 'vite';

// Deliberately minimal. There is no framework plugin and no asset pipeline: every
// texture in this project is generated in code, so the only thing Vite does for us
// is serve ES modules with HMR in dev and bundle them for `npm run build`.
export default defineConfig({
  // Relative base so a built copy can be opened from any subdirectory or file host.
  base: './',
  server: {
    port: 5173,
  },
});
