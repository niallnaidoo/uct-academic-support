import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE is '/' for local dev; the GitHub Pages workflow sets it to
// '/uct-academic-support/' so asset URLs resolve under the project subpath.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  // The 3k-entry course catalogue is imported as JSON; stringify keeps Rollup
  // from parsing a giant object literal at build time (pathologically slow).
  json: { stringify: true },
  server: { port: 3200, host: true },
  preview: { port: 3200, host: true },
});
