# Merge plan: wnight into midnight-cold-hot

Status: **phase 1 in progress (2026-11-26).** Done: wnight merged with its history as `packages/contract` and `packages/wnight-cli`, npm workspaces, the package renamed `cold-crossing`; all suites pass and the cold bundle installs the same 112 packages. Still to do in phase 1: the `core`/`cold`/`hot` split, the cold bundle from `packages/cold`, the import-boundary check, the repository and folder rename, and a Preprod `wallets` run of the wnight CLI. The owner's decisions (history, name) were made on 2026-11-26.

## 1. Goal and what is possible today

**The goal.** One project for sending value on Midnight while the cold wallet's keys stay on an offline machine:

- **Unshielded:** send NIGHT (or another unshielded token) to an unshielded address. Built: `cold-transfer`, sections 3–11.
- **Shielded:** wrap NIGHT into shielded wNIGHT, send it shielded, and redeem it back to NIGHT for any unshielded address.
  - The shielded send from the cold wallet is built: `cold-shielded-transfer`, section 13.
  - Wrap and redeem exist only as online scripts in wnight, with the keys on the online machine.
- **Cardano assets in and out:** a Cardano asset coming in, moving shielded, and going out to a Cardano address.

**The Cardano leg cannot be built yet, in one project or two.** wnight never touches Cardano: it wraps tNIGHT, which is native to Midnight. As of 2026-11-25:

- The official Cardano–Midnight bridge is inert on Preprod.
- USDM's VIA bridge is mainnet only (package 2.0.0).
- Nothing arrives on Midnight as a shielded asset.

So the merged project covers everything on Midnight and leaves an empty **bridge adapter** slot (section 7) for when a bridge works on a test network.

**What the merge itself buys.** Removing the duplication that is already drifting apart:

| | wnight | cold-hot |
|---|---|---|
| Wallet SDK | 2.0.1, prover client 2.0.1, ledger-v9 1.0.2 | 2.0.0, prover client 2.0.0, ledger-v9 1.0.1 |
| Saved wallet state | `.wallet-state/<network>-<seed hash>.json`, stamped with indexer host and block | `wallet-state-<address>.json` in the working folder, unstamped |
| Sync | `syncWallet` (pino log, stall timeout, saves) | `syncAndSave` (console, saves): ported from wnight on 2026-11-25 |
| DUST fork start | `cli/src/dustFork.ts`, cache in `.wallet-state/` | `src/dustfork.ts` (a port), cache in the folder |
| Endpoints | `cli/src/config.ts` | `src/config.ts` (with token redaction) |
| Logging | pino | `console`, plus `redact.ts` and `logfilter.ts` |
| Tests | vitest (contract simulator) | `node:test`, Python unittest, headless page tests |
| Runs | `tsx` from source | `tsc` to `dist/`, so the cold bundle needs no compiler |

The two state formats cannot read each other. That is why cold-hot's `sponsor-submit` did not find a sponsor that had been synced in wnight. I compared the key pins: prover client 2.0.0 and 2.0.1 pin the **same key hashes** (only the ledger release label differs), so moving cold-hot to 2.0.1 does not change `prover-keys/`.

## 2. Decisions

1. **Base repository: midnight-cold-hot.** Recommended.
   - It has the stricter rules (CLAUDE.md, the pre-commit hook, wallet-data names, the `Verified:` and `Touches-cold:` trailers), the test plan and the cold bundle.
   - Its rules then apply to wnight's code too. That costs wnight some looseness (no `git add -A`, no secrets in `.env` files that the hook blocks).
2. **History** (owner, decided 2026-11-26): **keep wnight's history.** wnight is first moved into its subfolder on a branch of its own repo, then merged here with `git merge --allow-unrelated-histories`, so `git log --follow` reaches its old commits.
3. **Packages: npm workspaces, one lockfile.**
   - The cold bundle must not grow by wnight's ~450 MB of Midnight.js and testkit, which the cold machine never needs.
   - So the bundle is built from the cold package's own dependency set (`npm ci --omit=dev -w packages/cold`, to verify in phase 1). There is a check that `packages/cold` does not import `packages/hot`, `packages/wnight-cli`, or any network client.
4. **One SDK version: wallet SDK 2.0.1** (and its ledger-v9 1.0.2, effect 3.22.5) for every package.
5. **Conventions:** cold-hot's.
   - `tsc` to `dist/` and `node:test` for core, cold and hot.
   - The contract package keeps vitest for its simulator tests, as a dev dependency only.
   - The wnight CLI keeps pino for now; it is online and dev-only.
6. **One saved-state format** (section 4.2). Old files are read once and rewritten.
7. **Name** (owner, decided 2026-11-26): **`cold-crossing`**, for now. It names the cold keys and the Cardano-Midnight round trip without tying the project to a bridge design. The rename happens in phase 1 together with the merge: the repo and folder name, the package names, the bundle paths in the README and CLAUDE.md.

## 3. Target layout

```
packages/
  core/         pure, no SDK network code, unit tested
                mqr-core, mqr, zswapfeed, snapshot, txinfo, syncprogress, timefmt, hex, redact, logfilter
  cold/         offline only; may import core, the ledger, zkir, compact-runtime; never a network client
                keys, keygen, cold-export-public, cold-transfer, cold-shielded-transfer, coldshielded, coldpage/,
                qr-decode, qr-render, qr-send, syncnotice, probe-cold-era
                later: cold-deposit, cold-redeem, contract-call building (section 5)
  hot/          online; holds no cold secret
                config (endpoints), wallet (one wallet layer: build, restore, sync, save), dustfork, sponsor-sync,
                sponsor-register, sponsor-submit, hot-watch, hot-zswap-feed, hot-inspect, dust-watch, crosscheck,
                hotpage/, tools/hot_server.py
                later: hot-contract-feed (section 5)
  contract/     wnight.compact, index.ts, simulator tests; managed/ is build output (gitignored, as now)
  wnight-cli/   online developer CLI on the hot wallet layer: deploy, deposit, transfer, redeem, consolidate,
                wasm-transfer, wallets. For deploying and for testing without the cold machine.
cold-page/ hot-page/ receiver/ prover-lab/ scripts/ tools/ tests*/   as now, with paths updated
HANDOVER.md (from wnight)  MIGRATION-LEDGER9.md  README.md  CLAUDE.md  CONTRIBUTING.md
```

### File moves

| From | To | Change |
|---|---|---|
| cold-hot `src/{mqr-core,mqr,zswapfeed,snapshot,txinfo,syncprogress,timefmt,hex,redact,logfilter}.ts` | `packages/core/src/` | imports only |
| cold-hot `src/{keys,keygen,cold-*,coldshielded,coldpage/,qr-*,syncnotice,probe-cold-era}.ts` | `packages/cold/src/` | imports only |
| cold-hot `src/{config,wallet,dustfork,sponsor-*,hot-*,dust-watch,dustgen,crosscheck,beep}.ts`, `src/hotpage/` | `packages/hot/src/` | `wallet.ts` becomes the one wallet layer (4.2, 4.3) |
| cold-hot `src/proverlab/` | `packages/cold/src/proverlab/` | none |
| wnight `contract/src/` | `packages/contract/src/` | `zkConfigPath` points at the new `managed/` |
| wnight `cli/src/{deploy,deposit,transfer,redeem,consolidate,wasm-transfer,wallets}.ts` | `packages/wnight-cli/src/` | built on `packages/hot` wallet layer |
| wnight `cli/src/{wallet,dustFork,config,wasmProver}.ts` | merged into `packages/hot/src/` | duplicates deleted after the merge (4.2–4.4) |
| wnight `cli/src/providers.ts` | `packages/wnight-cli/src/` | Midnight.js providers stay out of hot and cold |
| wnight `compose.yml`, `.env.example` | root | `.env.example` merged with cold-hot's variables |
| wnight `HANDOVER.md` | root | bridge facts stay; status updated |

## 4. Unifying what is duplicated

### 4.1 SDK versions (phase 2)

- Move cold-hot to wallet SDK 2.0.1, prover client 2.0.1, effect 3.22.5, and ledger-v9 1.0.2 through the SDK.
- Re-run every cold-hot suite (`npm test`, `test:sdk`, `test:server`, `test:hotpage`, `test:page`, `test:prover-lab`).
- Re-run the Node 22 offline checks from README section 5, and `sha256sum -c` in `prover-keys/`. The key pins are the same, so `prover-keys/` should still match.
- Re-verify one Preprod unshielded transfer, because the cold bundle changes.

### 4.2 One saved wallet state (phase 3)

**Format:** wnight's version 2:

- the shielded, unshielded and DUST states
- `chain: { indexer host, height, block hash }`, which is checked before a restore; on a mismatch the wallet syncs afresh

**Place and name:** `.wallet-state/<network>-<unshielded address>.json` in the working folder.

- The address is public, so `syncnotice` and the hot page can name a wallet's state without its secret.
- The address avoids wnight's seed hash, which can only be computed with the secret.

**Migration:** both kinds of old file are read once and saved in the new form.

- An old cold-hot `wallet-state-<address>.json` is unstamped; it is restored like wnight's version 1 and stamped on its next save.
- wnight's `preprod-<seed hash>.json` is renamed by a one-off script that derives the address. The script needs the secret, so the owner runs it in their own terminal.

**Rules:** CLAUDE.md, `.gitignore` and the pre-commit hook get `.wallet-state/` in place of `wallet-state-*.json`.

### 4.3 One sync (phase 3)

- `syncAndSave` in `packages/hot` gains the parts of wnight's `syncWallet` it lacks:
  - the stall timeout (`timeout.each` placed before the completion filter)
  - the "strictly complete" check of all three parts
  - the funding gate (`waitForNightThenDust`) as a separate step
- `MIDNIGHT_SYNC_LOG_INTERVAL_MS` and `MIDNIGHT_WALLET_SAVE_INTERVAL_MS` keep their meaning.
- The wnight CLI's `openWallet` becomes a thin wrapper over it. The early warnings (cold-hot `syncnotice`, wnight `warnIfOtherWalletUnsynced`) become one function that works by address.

### 4.4 Endpoints, DUST fork start, WASM prover (phase 3)

- **Endpoints:** one `config.ts`: cold-hot's, which redacts the token.
- **DUST fork start:** one `dustfork.ts`, with its cache moved into `.wallet-state/`.
- **WASM prover:** wnight's `useWasmProver` (for SDK wallet proofs) moves to hot. The cold side keeps its own zkir proving with local, pinned key files.

## 5. New cold work: wrap and redeem from the cold wallet

This is the part that needs research before code. What each wnight circuit needs, and where its proofs can be made:

| | `deposit(amount, nonce)` (wrap) | `redeem(coin, recipient)` |
|---|---|---|
| What the transaction holds | contract call; cold's unshielded NIGHT inputs (signed); a wNIGHT mint to cold's coin public key; sponsor's DUST fee | cold's wNIGHT spend(s) (zswap proofs); a fresh coin `c` output to the contract; contract call; NIGHT sent to `recipient`; sponsor's DUST fee |
| Secret used | the cold **unshielded signing key** (inputs) | the cold **coin secret key** (in the spend proofs' witness) |
| Contract proof witness | amount, nonce, own coin public key: not secret | `c`, recipient: not secret |
| Contract state read | `deposits` counter, totals | totals, `redeemed` set |
| Prover key | `deposit.prover` 22.5 MB | `redeem.prover` 45 MB |

**Where to prove the contract call.**

- **Recommended: the cold machine proves the whole transaction, including the contract call, in WASM.** The cold machine has then built everything it signs or spends, and a compromised hot machine cannot change the redeem's NIGHT recipient or the mint's owner. The cold side then needs:
  - a **contract state feed** from the hot machine: public, small, checked against the chain like the zswap feed
  - the contract's prover keys, pinned by SHA-256 in the bundle like `prover-keys/`
  - `@midnight-ntwrk/compact-runtime` in the cold package: a new cold dependency, to review
- **The alternative:** the hot machine proves the call on a proof server (it holds no secret) and the cold machine only signs or spends.
  - This is simpler and faster, but the cold machine must then check, before it signs, that the call is exactly the one it intends.
  - Unless that check is complete, this weakens the current guarantee that the hot machine cannot redirect funds.

**Open questions for the spike (phase 4):**

1. How long WASM proving of `deposit` and `redeem` takes, and how much memory, on Node 22 offline. The zswap spend circuit (k=15) takes about 2 minutes. `redeem.prover` is 4× its size.
2. **Minted coins carry no ciphertext.** The cold wallet cannot find its new wNIGHT by decrypting the feed. It knows the coin, because the nonce comes from `deposits` and its own `nonce`, so the rebuild would have to watch for it (`ZswapLocalState.watchFor`). To confirm.
3. **Contract state goes stale.** Another user's deposit or redeem between the cold machine's proof and inclusion changes the totals. The call then probably fails rather than doing harm. Measure how often, and keep the window short (feed, prove, submit within minutes), as with the zswap feed's 50 minutes.
4. Whether `sponsor-submit` balances a transaction that has a contract call and unshielded inputs with `tokenKindsToBalance: ['dust']`, as it does for the shielded spend.

**Then (phase 5):** `cold-deposit` and `cold-redeem` CLIs, the `hot-contract-feed` command, `sponsor-submit` showing contract calls, and new rows in the test plan. The cold page follows later (phase 6).

## 6. Phases

Each phase ends with every suite green and an entry in the test plan.

| Phase | Work | Done when |
|---|---|---|
| 0 Baseline | Finish T40–T45 on the current two projects; note both last commits | T40–T45 have results |
| 1 Repo merge, no behaviour change | rename to `cold-crossing`; wnight in as `packages/contract` and `packages/wnight-cli`, cold-hot `src/` split into `core`/`cold`/`hot`; workspaces; cold bundle from `packages/cold` only; import-boundary check in the pre-commit hook or a test | all existing suites pass; bundle builds and passes section 5's offline checks; wnight CLI runs a Preprod `wallets` |
| 2 One SDK version | 4.1 | suites pass; one Preprod unshielded transfer and one shielded transfer |
| 3 One wallet layer | 4.2–4.4; state migration script; delete duplicates | wnight CLI and sponsor share state; a sponsor synced by either is resumed by the other |
| 4 Spike | section 5 questions 1–4, throwaway wallets on Preprod | written answers and timings; go/no-go on cold contract proving |
| 5 Cold wrap and redeem | CLIs, contract feed, tests | cold deposit and cold redeem pass on Preprod |
| 6 Pages | cold page: shielded send, wrap, redeem; hot page: feeds | page tests and one run per flow |
| 7 Bridge adapter | an interface where an asset arrives and leaves; nothing behind it | only when a bridge works on a test network |

Phases 1–3 change no flow and can stop at any point. Phases 4–5 are where new risk is, and phase 4 can say no.

## 7. Bridge adapter (later)

A single interface: *an asset arrives at this Midnight address* and *send this asset to this Cardano address*. The flows above stay unchanged behind it. Keep the bridge facts current in HANDOVER.md section 2a, and re-check them before phase 7.

## 8. Risks

- **The cold bundle grows or gains network code.** Mitigations: the import-boundary check, the bundle built from `packages/cold` only, and section 5's offline checks (`unshare -rn`) re-run in every phase.
- **State migration loses a long sync.** The migration only copies and renames, and keeps the old files until the next successful save. The owner runs the part that needs a secret.
- **Workspaces and the cold bundle.** If `npm ci -w` cannot give the cold package a clean dependency set, fall back to two lockfiles (root for hot and dev, `packages/cold` for cold).
- **Contract proving in WASM is too slow or too large** (phase 4). Then the alternative in section 5 is the fallback, with a complete pre-sign check, or wrap and redeem stay online-only.
- **wnight's looser habits** (pino logs that can print URLs, `.env` with phrases). Mitigation: redaction applies to every package, and the hook blocks `.env` files as now.
