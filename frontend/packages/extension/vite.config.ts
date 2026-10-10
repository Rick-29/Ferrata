import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.ts';

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      '@sqw/types': fileURLToPath(new URL('../types/src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      // The approval window is opened by the background worker, not referenced by the manifest.
      input: { approval: 'src/approval/index.html' },
    },
  },
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
