# Prover lab (experiment)

**Question:** can the offline cold machine make Midnight zero-knowledge proofs in a browser, with no proof server?
This is a prerequisite for any future shielded cold flow. It is **not** part of the cold transfer flow: the page uses a
random throwaway key, a made-up coin and no wallet, and it cannot reach a network (`connect-src 'none'`).

It proves **one shielded output** (the zswap `output` circuit, k = 14) with the zkir v2 prover compiled to WebAssembly,
the same prover code the wallet SDK's `WasmProver` and the proof server use. Then the ledger's own well-formedness check
verifies the proof against its built-in verifier key. An output needs no chain state or Merkle path, so this measures the
prover alone.

## Run

Online machine:
```
npm ci
npm run fetch:prover-keys          # prover-keys/: 4 public files, ~8.9 MB, SHA-256 checked against the SDK's pins
npm run build:prover-lab           # dist/prover-lab.html, ~19 MB, everything inlined
npm run test:prover-lab            # optional: headless Chromium, ~1 minute
npm run prover-lab:node            # optional: the same proof under Node, 3 runs
```
Cold machine: copy `dist/prover-lab.html` and `prover-keys/`, check `sha256sum -c SHA256SUMS` in `prover-keys/`, open the
page from the file, pick the four files, press **Prove**. The page stops responding while it proves.

Key files are accepted by **hash**, not name: only files whose SHA-256 matches `V9KeyMaterial` in
`@midnightntwrk/wallet-sdk-prover-client` (ledger 9, circuit generation 10) are used. The pins are inlined at build time.

## Results

| Date | Where | Prove | Verify | Prover memory | Notes |
|---|---|---|---|---|---|
| 2026-11-25 | Node 22, Linux laptop, 8 logical CPUs | 49–60 s (3 runs) | 65–222 ms | RSS ~455 MiB | `prover-lab:node` |
| 2026-11-25 | Headless Chromium 158, same machine, `file://` page | 59.6 s | 257 ms | WebAssembly 223 MiB, JS heap 61 MiB | `test:prover-lab`, no network requests |
| 2026-11-25 | Node 26, same laptop, **full shielded transfer on Preprod** (wnight project, `npm run wasm-transfer`) | 249 s for 1 spend + 2 outputs + 1 DUST spend (parallel workers) | accepted on chain: block 3,578,130, SUCCESS | not measured | Real wNIGHT coin; SDK `provers: { v9: { kind: 'wasm' } }`; 18.5 KB transaction |
| | Tails, real offline machine | not yet run | | | |

Also checked once (ad hoc, not in the repo): flipping single bytes of a proven transaction made the ledger reject every
one that still parsed (397 of 397) with `Invalid proof -- while verifying Zswap proof`, so "verified" is a real check.

## What a shielded cold flow would add (not built)

- **Spend proofs** (zswap `spend`, 11 MB prover key): one per shielded coin spent; each needs the coin's Merkle path from a
  hot-side snapshot, and the spend witness contains the coin secret key, so it must be proved on the cold machine.
- A transfer is typically 1 spend + 2 outputs (recipient, change), plus a DUST spend unless a sponsor pays: measured
  249 s for all four under Node on the laptop above (wnight project). Expect more on a slower cold machine.
- **Time limit:** the ledger accepts a spend against a coin-tree root for one hour after the block that produced it
  (`past_roots` filter, 3600 s, in `zswap/src/ledger.rs`), so snapshot → prove → sponsor → inclusion must fit in that hour.
- Watching a shielded wallet needs its viewing key on the hot machine (CLAUDE.md: needs a design first).
