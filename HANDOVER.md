# Project Handover: Shielded NIGHT Wrapper on Midnight (Preprod)

> Context file for starting this project fresh in Claude Code.
> Written 2026-11-24; bridge facts (section 2 and 2a) updated 2026-11-25. Facts about Midnight change quickly. **Verify everything marked "VERIFY" against the current docs before relying on it.**

---

## 1. Goal

**Long-term vision:** A dApp that:
1. Locks a Cardano asset on Cardano.
2. Lets the asset move **shielded** (private) between addresses on Midnight.
3. Unlocks it to a (possibly different) Cardano address.

**Immediate scope (this project, test only):** Build and test the Midnight-only part on **Preprod**:
- Lock unshielded **tNIGHT** in a Compact contract.
- Mint a **1:1 shielded wrapped token** ("wNIGHT").
- Do a shielded transfer from wallet A to wallet B.
- Redeem: wallet B burns wNIGHT and receives the same amount of unshielded tNIGHT.

The Cardano lock/unlock bridge is **out of scope for now** (see section 6, later phases).

---

## 2. Key facts behind the design

| Fact | Implication |
|---|---|
| **NIGHT is always unshielded.** Only tokens minted with `mintShieldedToken` can move privately. | You can't send NIGHT itself shielded. You need a wrapper contract. |
| **DUST** is a shielded, non-transferable fee resource that NIGHT generates over time. | Fees are paid in DUST. You can't transfer it, and it isn't a value token. |
| The Preprod faucet sends **tNIGHT to the unshielded address** (`mn_addr_preprod1...`) and rejects shielded and DUST addresses. | Fund the unshielded address. Then **register tNIGHT for DUST** in Lace or with the wallet SDK so the wallet can pay fees. |
| On **9 Nov 2026, Preprod upgraded in place to ledger 9.** DUST registrations not backed by cNIGHT were cleared. | Re-register for DUST if you registered before then. Older tutorials and repos may use outdated APIs. **VERIFY Compact stdlib names.** |
| The official cNIGHT bridge (MIP-20) is **one-way only (Cardano to Midnight)**, takes about 12 hours, and mints to the **unshielded** Midnight address. On **Preprod it is not switched on** (checked 2026-11-25, see 2a). No Midnight-to-Cardano path has shipped. | You can't test it on Preprod yet. Nothing bridged arrives shielded: shielding still needs a wrapper contract like wNIGHT. |
| No bridge mints shielded tokens. "Bridge to an unshielded address, then wrap" links the Cardano lock to the Midnight deposit by amount and timing. | Private entry from Cardano still needs the Phase 2 design (commitment in the Cardano datum, ZK claim on Midnight). |
| The only other Cardano asset with a Midnight bridge is **USDM**, through VIA Labs: two-way, but testnet is **Cardano Preprod ↔ Midnight Preview** (not Preprod), and bridged USDM is unshielded. | Testing USDM means running on Midnight Preview, with a separate Blockfrost project or Midnight's own Preview endpoints. |
| Third-party bridges are high risk. Wanchain's Cardano-BNB bridge lost about 515M NIGHT in July 2026, reportedly from a signature-reuse flaw. | For any future bridge: use nonces and domain separation in signatures, rate limits, time delays and audits. |

### Useful links
- Docs index: https://docs.midnight.network/llms.txt (good to feed to Claude Code)
- Tokens overview: https://docs.midnight.network/tokens/overview
- Unshielded token tutorial: https://docs.midnight.network/tokens/unshielded-token
- Shielded token tutorial: https://docs.midnight.network/tokens (see "Shielded token")
- Funding a wallet / faucet: https://docs.midnight.network/guides/acquire-tokens
- Networks and environments: https://docs.midnight.network/guides/networks-and-environments
- Generating DUST programmatically: https://docs.midnight.network/guides/generating-dust-programmatically
- Preprod faucet: https://faucet.preprod.midnight.network/

The official shielded and unshielded token tutorials can be run against Preprod by setting `MIDNIGHT_NETWORK=preprod`. **Base this project on those tutorials.** The wrapper is essentially the two combined.

### 2a. Cardano ↔ Midnight bridge status (checked 2026-11-25)

**Official NIGHT bridge (MIP-20), Midnight Preprod.** Read from the chain at block 3,575,239 through Blockfrost RPC:
- `bridge.dataCheckpoint` is `null`. This is the governance switch that turns the bridge on (the node release notes say it "ships inert").
- `bridge.mainChainScriptsConfiguration.tokenAssetName` is still `NIGHT`; it should be empty. This is the bug in [midnight-node #1734](https://github.com/midnightntwrk/midnight-node/issues/1734), which makes the bridge ignore Cardano locks. The issue was closed on 2026-11-18, but the value on chain hasn't changed.
- `c2mBridge.transferCounter` is 0: no transfers have ever been made.
- To re-check: read those storage items with `@polkadot/api` over `wss://rpc.midnight-preprod.blockfrost.io/?project_id=...`.

**Official NIGHT bridge, Mainnet.** Not checked on chain. The [Midnight FAQ](https://midnight.network/faq) describes a phased rollout: one-way "shortly after mainnet launch", with the return direction "at a later stage". Community guides say the one-way bridge is live. The proposal itself is [MIP-20](https://github.com/midnightntwrk/midnight-improvement-proposals/issues/20).

**cNIGHT generating DUST** (Lace 2.5, Nov 2026). cNIGHT stays on Cardano and generates DUST for a Midnight address. This is active on Preprod (the `cNightObservation` pallet). It moves no tokens, so it is not a bridge.

**USDM through VIA Labs.** Lock on Cardano, then mint natively on Midnight; burn on Midnight, then unlock on Cardano.
- Testnet: Cardano Preprod ↔ Midnight **Preview**. Mainnet: listed as live by VIA, "next" per Moneta.
- Bridged USDM is unshielded.
- Package: `@via-labs-tech/usdm-bridge`. The guide's examples use ledger-v8 packages, so check ledger 9 compatibility first.
- Testnet USDM token type on Midnight: `003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73`.
- tUSDM faucet (Cardano Preprod): https://tusdm.moneta.global
- Guides: [VIA guide](https://developer.vialabs.tech/docs/examples/guides/usdm-cardano-midnight/), [Moneta](https://moneta.global/midnight/).

**Endpoints**
| Network | Indexer (HTTP / WS) | Node RPC | Notes |
|---|---|---|---|
| Preprod | `https://midnight-preprod.blockfrost.io/api/v0` / `wss://…/api/v0/ws` | `https://rpc.midnight-preprod.blockfrost.io` | Blockfrost only. `rpc.preprod.midnight.network` was shut down on 2026-11-18. |
| Preview | Blockfrost: `https://midnight-preview.blockfrost.io/api/v0`; or Midnight: `https://indexer.preview.midnight.network/api/v4/graphql` | Blockfrost: `https://rpc.midnight-preview.blockfrost.io`; or Midnight: `https://rpc.preview.midnight.network` | Midnight-hosted Preview needs no key. Blockfrost needs a **separate Preview project**: a Preprod key is refused ("Network token mismatch"). |
| Mainnet | `https://midnight-mainnet.blockfrost.io/api/v0` | `https://rpc.midnight-mainnet.blockfrost.io` | Blockfrost only. |

Sources: [Blockfrost Midnight docs](https://blockfrost.dev/start-building/midnight/), [Midnight node endpoints](https://docs.midnight.network/nodes/node-endpoints).

---

## 3. Contract design: `wnight.compact`

### Ledger state (public)
- `totalLocked: Uint` (tNIGHT held by the contract)
- `totalMinted: Uint` (wNIGHT minted minus burned)
- Anything else needed to prevent double-redeem (coin nullifiers are usually handled by the ledger. **VERIFY**).

### Circuits

**`deposit(amount)`**
1. Receive `amount` unshielded tNIGHT into the contract.
2. Mint `amount` wNIGHT with `mintShieldedToken` to the caller's shielded coin public key.
3. `totalLocked += amount; totalMinted += amount`.

**Shielded transfer** (no contract call)
- Wallet A sends wNIGHT to wallet B's `mn_shield-addr_preprod1...` with a normal shielded transfer.

**`redeem(coin, recipient)`**
1. Receive the shielded wNIGHT coin into the contract.
2. Burn it (**VERIFY** the correct burn mechanism in the current stdlib).
3. Send `coin.value` unshielded tNIGHT to `recipient`.
4. `totalLocked -= value; totalMinted -= value`.

### Invariant
`totalMinted == totalLocked == contract's tNIGHT balance` at all times.

### Stdlib functions to look up (VERIFY names and signatures for ledger 9)
`mintShieldedToken`, `mintUnshieldedToken`, `receiveUnshielded`, `sendUnshielded`, `receiveShielded`, `sendShielded`, `ownPublicKey`, and the token-type / domain-separator helpers for custom token colors.

---

## 4. Test plan (TypeScript, Preprod)

Setup:
- Two wallets, A and B, made with the wallet SDK (`@midnight-ntwrk/wallet-sdk-*`). Keep seeds in `.env`, never commit them.
- Fund A's unshielded address from the faucet, register for DUST, and wait for DUST to accrue.
- Start the local proof server (Docker).

Happy path:
1. Deploy `wnight`.
2. A deposits a fixed amount (for example 100 tNIGHT). Check that A's shielded wNIGHT is 100 and `totalLocked` is 100.
3. A sends 100 wNIGHT, shielded, to B. Check B's shielded balance.
4. B redeems to B's unshielded address. Check that B gets 100 tNIGHT and the totals return to 0.

Negative tests (should all fail):
- Redeem more than deposited.
- Redeem the same coin twice.
- Redeem a coin of a different token type.
- Deposit 0 or a mismatched amount.

Privacy observation:
- Use round, fixed amounts. Note that the deposit and redeem are visible on the explorer (https://preprod.midnightexplorer.com/) and can be linked by amount and timing. Only the middle hop is private.

---

## 5. Suggested repo layout

```
wnight/
  contract/
    src/wnight.compact
    src/test/            # contract unit tests (simulator)
  cli/
    src/deploy.ts
    src/deposit.ts
    src/transfer.ts
    src/redeem.ts
    src/wallets.ts       # wallet setup, DUST registration
  .env.example           # SEED_A, SEED_B, MIDNIGHT_NETWORK=preprod
  README.md
```

---

## 6. Later phases (not now)

**Phase 2: Cardano round trip (Cardano preprod plus Midnight preprod)**
- Cardano side: Aiken validator that locks a native asset. The deposit datum holds a **commitment** (a hash of a secret), not the Midnight recipient, to avoid linking.
- Midnight side: the claimer proves knowledge of the secret in ZK, and the contract mints wrapped shielded tokens.
- Exit: burn on Midnight, record the Cardano destination, then unlock on Cardano.
- Why build this rather than reuse an existing bridge (as of 2026-11-25, see 2a): the official bridge is one-way, NIGHT only, mints unshielded, and is inert on Preprod. The USDM bridge is unshielded and runs on Preview, not Preprod. Both expose the Cardano-to-Midnight link that the commitment design avoids.
- Cheaper interim option: generalize `wnight` to wrap any unshielded token type (for example bridged USDM on Preview). It is private only after the deposit, not at entry.

**Unlock authorization options:**
- **Committee unlock (recommended first):** a bridge-specific M-of-N set of signers that you choose. Simple and under your control, but it adds a trust assumption. Harden it with independent operators, stake and slashing, key rotation, **rate limits and a time delay**, and nonce and domain-separated signatures.
- **Federated unlock:** rely on Midnight's own federated block producers' finality signatures. Adds no new trust, but depends on how Midnight exposes and rotates those keys.
- **ZK light client (long term):** verify a proof of Midnight state in Plutus V3 (BLS12-381 built-ins).
- Design the Cardano validator so the signature check **can be swapped out** later.

**Compliance note:** A lock, shield and unlock-elsewhere flow works like a mixer, and regulators have gone after those. Look at Midnight's selective disclosure and viewing keys, and get legal advice before any mainnet launch.

---

## 7. Suggested first prompt for Claude Code

> Read HANDOVER.md. Then fetch https://docs.midnight.network/llms.txt and the shielded and unshielded token tutorials, and confirm the current (ledger 9) Compact stdlib names for minting, receiving and sending shielded and unshielded tokens. Report any differences from the handover. Then scaffold the repo in section 5 based on the official tutorial setup, and write `wnight.compact` with `deposit` and `redeem` circuits plus simulator unit tests for the invariant and negative cases. Don't touch real funds. Target Preprod only.
