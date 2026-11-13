// Stand-in for dist/sponsor-submit.js in the hot page tests: no wallet, no network. It asks the same question on the
// same stream, so the server's prompt detection and its typed SUBMIT are tested against the real wording.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const txFile = args.find((a) => !a.startsWith('--')) ?? 'tx.hex';
console.log(`Network: ${process.env.MIDNIGHT_NETWORK}`);
console.log(`ARGS ${JSON.stringify(args)}`);
// Says only whether the secret reached the script, never the value: the server passes its environment on unchanged.
console.log(`Sponsor secret in the environment: ${process.env.SPONSOR_MNEMONIC ? 'yes' : 'no'}`);
console.log(`Read ${txFile}: ${readFileSync(txFile, 'utf8').trim().length / 2} bytes.`);
process.stdout.write('\x07\x1b[32mSynced\x1b[0m in 1 s.\r\n');
console.log('DUST fee estimate: 0.300000 DUST');
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `The sponsor wallet will pay the fee${dryRun ? ' (dry run, no submission)' : ' and submit this transaction'}. Type SUBMIT to continue: `,
);
rl.close();
if (answer.trim() !== 'SUBMIT') {
  console.log('Cancelled. Nothing was balanced or locked.');
  process.exit(1);
}
const waitMs = Number(process.env.FAKE_SUBMIT_MS ?? '0');
if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
if (dryRun) {
  console.log('Dry run complete: balanced and finalized, not submitted. The sponsor\'s DUST was released.');
} else {
  writeFileSync('fake-submitted', '');
  console.log(`Submitted transaction ${'ab'.repeat(32)}`);
}
process.exit(0);
