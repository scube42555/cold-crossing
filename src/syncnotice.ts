// The "sync the sponsor early" notice, printed by the first step of each flow (src/syncprogress.ts decides what it says).
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_FILE_RE, sponsorNotice } from './syncprogress.js';

/** Hot machine: look at the saved sponsor states in this folder (file names and ages only; nothing is read or decrypted). */
export const printSponsorNotice = (dir = '.'): void => {
  const files = readdirSync(dir)
    .filter((n) => STATE_FILE_RE.test(n))
    .map((name) => ({ name, mtimeMs: statSync(resolve(dir, name)).mtimeMs }));
  const { level, lines } = sponsorNotice(files, Date.now(), resolve(dir));
  const out = level === 'warn' ? console.warn : console.log;
  out('');
  for (const l of lines) out(l);
  out('');
};

/** Cold machine: it cannot see the hot machine, so a reminder only. */
export const COLD_SYNC_REMINDER =
  'Reminder: the last step, sponsor-submit on the hot machine, needs the sponsor wallet synced. If it has not been synced ' +
  'recently, start `npm run hot:sponsor-sync` on the hot machine now; a first sync takes hours.';
