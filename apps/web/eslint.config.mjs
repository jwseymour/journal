import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * The boundary, enforced at lint time.
 *
 * The frontend holds no logic, no knowledge of storage, and no path across the
 * boundary other than HTTP (`requirements.md` §7.1, `design.md` §6.3,
 * `plan.md` standing rules 1 and 3).
 *
 * This rule exists because the violation is always easy and always local: one
 * `readFile` in a server component, one import of the store "just to reuse the
 * type", and the frontend has stopped being disposable. Being told at the
 * moment of writing is worth more than being told at review.
 *
 * `scripts/check-boundary.sh` checks the same thing with grep, so the rule
 * cannot be quietly disabled without the second check noticing.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...['fs', 'fs/promises', 'node:fs', 'node:fs/promises'].map((name) => ({
              name,
              message:
                'The frontend never touches the filesystem. Entries are read and written through the API (`requirements.md` §7.1).',
            })),
            ...['path', 'node:path', 'os', 'node:os'].map((name) => ({
              name,
              message:
                'Paths are storage detail and live behind the API. The frontend has no notion of where an entry sits (`requirements.md` §7.1).',
            })),
            ...['child_process', 'node:child_process'].map((name) => ({
              name,
              message:
                'The frontend runs no processes. In particular it never invokes git (`requirements.md` §4.4).',
            })),
            {
              name: 'yaml',
              message:
                'Parsing an entry is the backend’s job. The frontend receives fields, never frontmatter (`requirements.md` §7.1).',
            },
          ],
          patterns: [
            {
              group: ['@journal/api', '@journal/api/**', '**/apps/api/**'],
              message:
                'No same-process shortcut across the boundary, ever, including from server components (`plan.md` standing rule 3). Call the API over HTTP.',
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
