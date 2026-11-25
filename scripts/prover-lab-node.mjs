// Runs the prover lab's proof under Node, from files on disk: the same code the page runs (dist/proverlab/core.js), for a
// baseline to compare the browser with. No network: the files come from scripts/fetch-prover-keys.mjs.
//   npm run build:prover-lab && node scripts/prover-lab-node.mjs [folder] [runs]
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '@midnightntwrk/wallet-sdk/ledger/v9';
import * as Z from '@midnightntwrk/zkir-v2';
import { identify, proveOneOutput } from '../dist/proverlab/core.js';
import { pins } from './prover-lab-pins.mjs';

const dir = process.argv[2] ?? 'prover-keys';
const runs = Number(process.argv[3] ?? 3);
const files = new Map();
for (const f of readdirSync(dir)) {
  if (f === 'SHA256SUMS') continue;
  const bytes = new Uint8Array(readFileSync(join(dir, f)));
  const name = identify(createHash('sha256').update(bytes).digest('hex'), pins);
  if (!name) throw new Error(`${f} is not a file the SDK pins; remove it.`);
  files.set(name, bytes);
}
console.log(`Loaded ${[...files.keys()].join(', ')}`);
for (let i = 1; i <= runs; i++) {
  const r = await proveOneOutput(L, Z, files, pins, new Uint8Array(randomBytes(32)), () => performance.now());
  console.log(
    `run ${i}: proved in ${(r.proveMs / 1000).toFixed(2)} s, verified in ${r.verifyMs.toFixed(0)} ms, ${r.txBytes} bytes; ` +
      `asked for: ${r.requests.join(', ')}; rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`,
  );
}
