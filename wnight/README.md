# wNIGHT — shielded 1:1 wrapper for tNIGHT (Midnight Preprod, test only)

Lock unshielded tNIGHT in a Compact contract, get the same amount of a shielded
token (wNIGHT), move it privately between wallets, and redeem it back to tNIGHT.
See `../HANDOVER.md` for the background and design.

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
(`examples/private-tip-jar`, `examples/private-party`). `cli/src/wallet.ts`,
`cli/src/config.ts`, `contract/src/test/sim.ts` and `contract/src/test/coins.ts`
are copied from it (Apache-2.0).

## Layout

```
contract/src/wnight.compact          the contract (deposit, redeem)
contract/src/index.ts                CompiledContract wrapper for Midnight.js
contract/src/test/wnight.sim.test.ts in-memory simulator tests
cli/src/wallets.ts                   wallets A/B from .env, DUST, Preprod guard
cli/src/{deploy,deposit,transfer,redeem}.ts
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
5. `npm run deposit -- 100`, `npm run transfer -- 100`, `npm run redeem -- 100`

Amounts are tNIGHT; the contract works in STAR (1 tNIGHT = 10^6 STAR).

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
