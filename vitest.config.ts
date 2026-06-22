import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig paths so tests import @shared/* like the worker does.
      '@shared': fileURLToPath(new URL('./shared/src', import.meta.url)),
    },
  },
  test: {
    include: ['worker/test/**/*.test.ts', 'shared/test/**/*.test.ts'],
    environment: 'node',
  },
});
