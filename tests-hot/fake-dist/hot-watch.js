// Stand-in for dist/hot-watch.js in the hot page tests: no wallet, no network. It "syncs" by copying a prepared file.
// After the stand-in sponsor-submit has "submitted" (it leaves a marker file), it copies the after-the-spend snapshot.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

const [publicFile, outFile] = process.argv.slice(2);
console.log(`Network: ${process.env.MIDNIGHT_NETWORK}`);
console.log(`ARGS ${JSON.stringify(process.argv.slice(2))}`);
const pub = JSON.parse(readFileSync(publicFile, 'utf8'));
if (process.env.FAKE_WATCH_FAIL) {
  console.error('Timed out after 10 minutes: available coins=0, pending=0.');
  process.exit(1);
}
const waitMs = Number(process.env.FAKE_WATCH_MS ?? '0');
if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
const source = existsSync('fake-submitted') && process.env.FAKE_SNAPSHOT_AFTER ? process.env.FAKE_SNAPSHOT_AFTER : process.env.FAKE_SNAPSHOT;
if (source) copyFileSync(source, outFile);
console.log(`Address:         ${pub.address}`);
console.log(`Wrote ${outFile}. Copy it to the cold machine.`);
process.exit(0);
