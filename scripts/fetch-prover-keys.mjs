// ONLINE MACHINE ONLY. Downloads the public key files the prover lab needs (zswap output circuit plus its public
// parameters) from the SDK's key host and keeps only files whose SHA-256 matches the SDK's pins.
//   node scripts/fetch-prover-keys.mjs [folder]     (default: prover-keys/)
// These files are public (the same ones every proof server downloads); no secret is involved. Copy the folder to the
// cold machine next to dist/prover-lab.html, and compare SHA256SUMS there with `sha256sum -c SHA256SUMS`.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pins, pinsSource } from './prover-lab-pins.mjs';

const HOST = 'https://srs.midnight.network/';
const dir = process.argv[2] ?? 'prover-keys';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const hostPath = (name) => (name.startsWith('params/') ? `bls_midnight_2p${name.slice(7)}` : name.replace('/', `/${pins.generation}/`));

const fetchPinned = async (name, expected) => {
  const url = new URL(hostPath(name), HOST);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url.href} answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== expected) throw new Error(`${url.href} hashes to ${got}, but the SDK pins ${expected}. Not saved.`);
  return bytes;
};

mkdirSync(dir, { recursive: true });
console.log(`Pins: ${pinsSource}`);
const sums = [];
const save = (name, bytes) => {
  const file = hostPath(name).split('/').pop();
  writeFileSync(join(dir, file), bytes);
  sums.push(`${sha256(bytes)}  ${file}`);
  console.log(`  ${file.padEnd(22)} ${String(bytes.length).padStart(10)} bytes  ok`);
};

const files = {};
for (const [name, digest] of Object.entries(pins.files)) save(name, (files[name] = await fetchPinned(name, digest)));

// The parameters file depends on the circuit size, read from the circuit itself.
const { Zkir } = await import('@midnightntwrk/zkir-v2');
const k = Zkir.deserialize(files['zswap/output.bzkir']).getK();
console.log(`  output circuit: k = ${k}`);
save(`params/${k}`, await fetchPinned(`params/${k}`, pins.params[String(k)]));

writeFileSync(join(dir, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`Wrote ${dir}/ (${sums.length} files) and ${dir}/SHA256SUMS.`);
