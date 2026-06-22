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
  ],
};
