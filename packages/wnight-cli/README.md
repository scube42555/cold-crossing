# wNIGHT — shielded 1:1 wrapper for tNIGHT (Midnight Preprod, test only)

> **Moved into cold-crossing (2026-11-26).** This was the wnight repository. The contract is now `packages/contract`
> and this CLI is `packages/wnight-cli`. Run the commands below **in this folder**: `.env`, `.wallet-state/`,
> `.deployment.json` and `midnight-level-db/` live here, as they did in the old wnight folder. From the repository root
> the same scripts are `npm run wnight:<script> -- <args>` (for example `npm run wnight:wallets -- B`).

Lock unshielded tNIGHT in a Compact contract, get the same amount of a shielded
token (wNIGHT), move it privately between wallets, and redeem it back to tNIGHT.
See `../../HANDOVER.md` for the background and design.

**Preprod only.** The CLI refuses any `MIDNIGHT_NETWORK` other than `preprod`.
Never put a seed that holds Mainnet funds in `.env`.

## Versions (ledger 9 compatibility matrix, 24 Nov 2026)

| Component | Version |
|---|---|
| Compact toolchain (`compact compile +0.36.1`) | 0.36.1, `language_version 0.28` |
| Compact runtime / Compact JS | 0.21.0 / 3.0.2 |
| Midnight.js, testkit-js | 5.0.1 |
| Wallet SDK (`@midnightntwrk/wallet-sdk`) | 2.0.1 |
| Proof server (`compose.yml`) | 9.0.2 |

The official token tutorials still show ledger 8 versions (compactc 0.31.1,
Midnight.js 4.1.1, wallet SDK 1.2.0), which Preprod no longer accepts. This
project follows the ledger 9 `midnight-examples` repo instead
(`examples/private-tip-jar`, `examples/private-party`). `src/wallet.ts`,
`src/config.ts`, `../contract/src/test/sim.ts` and `../contract/src/test/coins.ts`
are copied from it (Apache-2.0).

## Layout

```
../contract/src/wnight.compact          the contract (deposit, redeem)
../contract/src/index.ts                CompiledContract wrapper for Midnight.js
../contract/src/test/wnight.sim.test.ts in-memory simulator tests
src/wallets.ts                   wallets A/B from .env, DUST, Preprod guard
src/{deploy,deposit,transfer,redeem}.ts
```

## Contract tests (no network, no funds)

```
npm install
npm run compile:fast   # or `npm run compile` for ZK keys (needed to deploy)
npm test
```

## Preprod run

1. `cp .env.example .env`, set wallet A and B (`MNEMONIC_x` or `SEED_x`)
   and `BLOCKFROST_PROJECT_ID` (a Blockfrost "Midnight Preprod" project).
2. `npm run compile && npm run proof:up`
3. `npm run wallets` prints both unshielded addresses. Fund **both** from the
   faucet (https://midnight-tmnight-preprod.nethermind.dev/): B needs DUST to pay
   the redeem fee. The script registers the tNIGHT for DUST and waits for it.
4. `npm run deploy`
5. `npm run deposit -- 100`
6. `npm run transfer -- <B's mn_shield-addr_preprod1...> 100` (B's shielded
   address is printed by `npm run wallets`; any shielded address works)
7. `npm run redeem -- 100` (wallet B)

Amounts are tNIGHT; the contract works in STAR (1 tNIGHT = 10^6 STAR).

**Sync ahead.** Each script syncs only its own wallet, and saves it to
`.wallet-state/`. When a script starts and the *other* wallet has never been
synced here (or not for over a day), it says so up front, so that the slow sync
can run now instead of at the step that needs it: run
`npm run wallets -- B` (or `-- A`) in a second terminal. That is safe while
the first script uses only the other wallet; never run two scripts on the
same wallet at once. `MIDNIGHT_SYNC_LOG_INTERVAL_MS` (default 15000) sets how
often a sync prints its progress.

### Proving without a proof server (WASM)

`npm run wasm-transfer -- [amount] [shielded address]` sends wNIGHT from wallet B
(default 1 wNIGHT, to B itself) and makes **every proof in-process with the
wallet SDK's WebAssembly prover**: the prover a browser on an offline machine
would run. It prints the build and proving time and what was proved, then waits
for the transaction on chain. `MIDNIGHT_PROVER=wasm` switches any script's
wallet proofs to it; contract-call proofs (deposit, redeem) still use the proof
server. Key files come from the SDK's key host, checked against its pinned hashes.

Measured 25 Nov 2026 (Node 26, 8-core Linux laptop, Preprod): a self-transfer
with 1 shielded spend, 2 outputs and 1 DUST spend proved in **249 s** and was
accepted (block 3,578,130, status SUCCESS). A single shielded output takes about
50-60 s in WASM (cold-hot project, prover lab).

## Known limits and open points

- The simulator does not balance transactions or track nullifiers. That the
  wallet really pays the NIGHT for a deposit, and that a wNIGHT coin cannot be
  spent twice, is enforced by the ledger and only shows on Preprod.
- `redeem` receives a fresh coin and burns it in the same transaction with
  `sendImmediateShielded(coin, shieldedBurnAddress(), value)`. This works in the
  simulator; it has not yet been run on Preprod.
- Deposit and redeem amounts, the redeem recipient, and timing are public, so a
  deposit and a redeem of the same round amount can be linked. Only the
  wallet-to-wallet hop is private.
- NIGHT locked in the contract no longer generates DUST for the depositor.
- First wallet sync on Preprod: the shielded part takes minutes, DUST about
  2 hours (measured with a fresh wallet via Blockfrost). DUST starts at the
  ledger 9 fork thanks to `src/dustFork.ts`; without it the SDK's own
  fork search times out on Blockfrost and DUST replays from genesis (~1 day).
  Progress is saved every 5 minutes and on Ctrl-C, so a run can be resumed.
