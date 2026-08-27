import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * This app has no storage to reach across a boundary for — it only ever
 * calls `apps/public-api` over HTTP (`requirements.md` §10). The import
 * restrictions still apply, for the same reason `apps/web/eslint.config.mjs`
 * states them: the violation is always easy and always local, and this app
 * should never grow a reason to read a file or shell out either.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...['fs', 'fs/promises', 'node:fs', 'node:fs/promises'].map((name) => ({
              name,
              message: 'This app never touches the filesystem. Content comes from apps/public-api over HTTP.',
            })),
            ...['child_process', 'node:child_process'].map((name) => ({
              name,
              message: 'This app runs no processes.',
            })),
          ],
          patterns: [
            {
              group: ['@journal/api', '@journal/api/**', '**/apps/api/**', '@journal/public-api/**', '**/apps/public-api/**'],
              message: 'No same-process shortcut — call apps/public-api over HTTP, never its internals.',
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
