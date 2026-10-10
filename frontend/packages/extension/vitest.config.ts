import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests don't load the CRXJS extension plugin.
export default defineConfig({
  resolve: {
    alias: {
      '@sqw/types': fileURLToPath(new URL('../types/src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
