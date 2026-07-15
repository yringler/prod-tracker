/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
  },
  overrides: [
    {
      // Dependency arrows point inward. The browser bundle must never reach
      // worker code (DB drivers, secret handling) or be reached by shared/.
      files: ['client/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/worker/**', '@worker/*'],
                message:
                  'client/ must not import worker/ — keep DB drivers and secrets out of the browser bundle.',
              },
            ],
          },
        ],
      },
    },
    {
      // shared/ depends on nothing from client/ or worker/.
      files: ['shared/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/worker/**', '**/client/**', '@worker/*'],
                message: 'shared/ must not import from client/ or worker/.',
              },
            ],
          },
        ],
      },
    },
    {
      // Dependency arrows point inward. A notification adapter is a vendor-isolated
      // vertical slice: it may import @shared/*, the neutral contract, and files in
      // its OWN adapter directory — never app internals, never a sibling adapter,
      // never the registry (the registry imports adapters, not the reverse).
      files: ['worker/src/notifications/adapters/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '**/routes/**',
                  '**/cron/**',
                  '**/db/dao',
                  '**/db/dao.*',
                  '**/registry',
                  '**/index',
                ],
                message:
                  'notification adapters are vendor-isolated: import only @shared/*, the neutral contract, and files inside your own adapter directory — never app internals (routes/cron/dao/router) or the registry.',
              },
              {
                // Catches long-form sibling specifiers only; a terse relative
                // `../email/store` is not matched (no `notifications/adapters/`
                // segment in the string). Accepted per 02-prereq-plan.md Step 5 —
                // tighten to per-adapter-name lists when a 2nd adapter lands.
                group: ['**/notifications/adapters/*/**'],
                message:
                  'adapters must not import sibling adapters — each adapter is a self-contained vertical slice. Communicate only through the neutral contract.',
              },
            ],
          },
        ],
      },
    },
    {
      // App code (routes + cron) reaches notification channels ONLY through the
      // registry seam — never by deep-importing adapter internals. This keeps the
      // "app never learns what a zulip_user_id is" invariant CI-enforced.
      files: ['worker/src/routes/**/*.ts', 'worker/src/cron/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/notifications/adapters/**'],
                message:
                  'app code must reach notification channels via worker/src/notifications/registry — never deep-import an adapter’s internals.',
              },
            ],
          },
        ],
      },
    },
  ],
};
