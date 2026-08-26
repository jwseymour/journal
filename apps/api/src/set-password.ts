import { createInterface } from 'node:readline/promises';
import { hashPassword } from './auth/password.js';

/**
 * `npm run set-password -w @journal/api` — generates an `AUTH_PASSWORD_HASH`
 * value to paste into `.env` (`plan.md` M11). Never stores or transmits the
 * plaintext password itself; the hash printed here is the only thing that
 * needs to exist anywhere afterwards.
 *
 * Prompts in plain text — this is a one-off local script, not a login
 * surface, and hiding terminal input needs a dependency (or raw-mode TTY
 * handling) this one-time convenience does not justify.
 */
async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question('New password (visible as you type): ');
  rl.close();

  if (password.trim().length < 8) {
    console.error('[journal] refusing a password shorter than 8 characters.');
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  console.log('\nAdd this line to .env at the repository root:\n');
  console.log(`AUTH_PASSWORD_HASH=${hash}\n`);
}

main().catch((error: unknown) => {
  console.error('[journal] could not hash the password', error);
  process.exitCode = 1;
});
