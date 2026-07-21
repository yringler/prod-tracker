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
    // `client/test/**` is for PURE, Angular-free client modules only (today: the
    // `<sp-option-select>` option-list builders). It needs no extra config — the
    // `@shared` alias and the node environment above already cover it. There is
    // deliberately NO Angular TestBed / jsdom suite; see DEFERRED.md for why one
    // would not have caught the bug this glob was added for.
    include: ['worker/test/**/*.test.ts', 'shared/test/**/*.test.ts', 'client/test/**/*.test.ts'],
    environment: 'node',
  },
});
