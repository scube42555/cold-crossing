// The key hashes the prover lab trusts: exactly what the wallet SDK's prover client pins for ledger 9
// (`V9KeyMaterial` in @midnightntwrk/wallet-sdk-prover-client). Build- and online-side only; the page gets a copy inlined.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The package exports only its entry points; KeyMaterial.js holds the table, so load it by path.
const findPackageDir = (name) => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${name}. Run npm ci first.`);
    dir = parent;
  }
};

export const proverClientDir = findPackageDir('@midnightntwrk/wallet-sdk-prover-client');
export const zkirDir = findPackageDir('@midnightntwrk/zkir-v2');

const { V9KeyMaterial } = await import(pathToFileURL(join(proverClientDir, 'dist', 'effect', 'KeyMaterial.js')).href);

/** @type {import('../src/proverlab/core.js').Pins} */
export const pins = {
  generation: V9KeyMaterial.generation,
  files: Object.fromEntries(Object.entries(V9KeyMaterial.files).filter(([name]) => name.startsWith('zswap/output.'))),
  params: Object.fromEntries(Object.entries(V9KeyMaterial.params).map(([k, d]) => [String(k), d])),
};
export const pinsSource = `${V9KeyMaterial.ledgerRelease.packageName} ${V9KeyMaterial.ledgerRelease.version} (${V9KeyMaterial.ledgerRelease.tag}), circuit generation ${V9KeyMaterial.generation}`;

if (Object.keys(pins.files).length !== 3) throw new Error(`Expected 3 pinned zswap/output files, found ${Object.keys(pins.files).length}.`);
