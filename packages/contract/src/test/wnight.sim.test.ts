// In-memory tests for wnight.compact: the 1:1 invariant, the happy path and
// every guard, with no network, no proof server and no funds.
//
//   npm run compile:fast && npm test
//
// What the simulator can and cannot show:
// - It runs the real compiled circuits and records each call's effects: NIGHT
//   received into the contract (unshieldedInputs), NIGHT sent out
//   (unshieldedOutputs), shielded mints, and the Zswap inputs and outputs.
//   The tests track the contract's NIGHT balance from those effects, so the
//   invariant is checked against what the circuits actually ask the ledger to
//   move, not only against the contract's own counters.
// - It does NOT balance transactions or keep a nullifier set. Whether the
//   caller's wallet really pays the NIGHT for a deposit, or really holds the
//   wNIGHT for a redeem, is enforced by the ledger on Preprod, not here.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simCoin, tokenColor, type TokenColor } from './coins.js';
import { Sim, assertNotInPublicState, expectRejects, findInPublicState } from './sim.js';
import { Contract, ledger, pureCircuits, type Ledger } from '../managed/wnight/contract/index.js';

const bytes32 = () => new Uint8Array(randomBytes(32));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const NIGHT_RAW = '00'.repeat(32);
/** The shielded burn address's coin key, as the simulator records it. */
const BURN_KEY = '00'.repeat(32);

const ALICE_COIN_PK = hex(bytes32());
const BOB_COIN_PK = hex(bytes32());
const BOB_ADDRESS = { bytes: bytes32() }; // Bob's unshielded UserAddress

type WSim = Sim<Contract<object>, object, Ledger>;

/**
 * A deployed wnight simulation plus a model of the contract's NIGHT balance
 * and of wNIGHT circulating supply, both derived from call effects.
 */
class Harness {
  nightBalance = 0n;
  wnightMinted = 0n;
  wnightBurned = 0n;
  /** NIGHT paid out, per recipient address (hex). */
  payouts = new Map<string, bigint>();
  /** wNIGHT coins minted, as the simulator's Zswap outputs. */
  minted: { recipient: string; nonce: Uint8Array; color: Uint8Array; value: bigint }[] = [];

  private constructor(
    readonly sim: WSim,
    readonly color: TokenColor,
  ) {}

  static async deploy(): Promise<Harness> {
    const sim = (await Sim.deploy({
      contract: new Contract({}),
      ledger,
      privateState: {},
      coinPublicKey: ALICE_COIN_PK,
    })) as WSim;
    return new Harness(sim, tokenColor(pureCircuits.wnightDomain(), sim.address));
  }

  ledger(): Ledger {
    return this.sim.ledger();
  }

  async deposit(amount: bigint, from = ALICE_COIN_PK, nonce = bytes32()) {
    const out = await this.sim.as(from).call('deposit', amount, nonce);
    this.record();
    return out;
  }

  async redeem(coin: ReturnType<typeof simCoin>, recipient = BOB_ADDRESS, from = BOB_COIN_PK) {
    const out = await this.sim.as(from).call('redeem', coin, recipient);
    this.record();
    return out;
  }

  /** A fresh redeem coin description, as a client builds it with `freshCoin`. */
  coin(value: bigint, color = this.color.bytes) {
    return simCoin(value, color);
  }

  /** Folds the last call's effects into the balance and supply model. */
  private record(): void {
    const ctx = this.sim.lastContext as any;
    const effects = ctx.callContext.currentQueryContext.effects;
    for (const [type, amount] of effects.unshieldedInputs as Map<{ tag: string; raw: string }, bigint>) {
      expect(type).toEqual({ tag: 'unshielded', raw: NIGHT_RAW }); // only NIGHT ever comes in
      this.nightBalance += amount;
    }
    for (const [type, amount] of effects.unshieldedOutputs as Map<{ tag: string; raw: string }, bigint>) {
      expect(type).toEqual({ tag: 'unshielded', raw: NIGHT_RAW }); // only NIGHT ever goes out
      this.nightBalance -= amount;
    }
    for (const [[type, to], amount] of effects.claimedUnshieldedSpends as Map<
      [{ raw: string }, { tag: string; address: string }],
      bigint
    >) {
      expect(type.raw).toEqual(NIGHT_RAW);
      expect(to.tag).toEqual('user');
      this.payouts.set(to.address, (this.payouts.get(to.address) ?? 0n) + amount);
    }
    for (const [domain, amount] of effects.shieldedMints as Map<string, bigint>) {
      expect(domain).toEqual(hex(pureCircuits.wnightDomain())); // only wNIGHT is ever minted
      this.wnightMinted += amount;
    }
    const zswap = ctx.zswapLocalStates[this.sim.address];
    for (const o of zswap?.outputs ?? []) {
      if (o.recipient.is_left) {
        const key = hex(o.recipient.left.bytes);
        if (key === BURN_KEY) this.wnightBurned += o.coinInfo.value;
        else this.minted.push({ recipient: key, ...o.coinInfo });
      }
    }
  }

  /** totalMinted == totalLocked == NIGHT balance == wNIGHT in circulation. */
  assertInvariant(): void {
    const l = this.ledger();
    expect(l.totalMinted).toBe(l.totalLocked);
    expect(l.totalLocked).toBe(this.nightBalance);
    expect(l.totalMinted).toBe(this.wnightMinted - this.wnightBurned);
    expect(this.nightBalance >= 0n).toBe(true);
  }
}

describe('wnight (in memory)', () => {
  it('deploys with nothing locked or minted', async () => {
    const h = await Harness.deploy();
    const l = h.ledger();
    expect(l.totalLocked).toBe(0n);
    expect(l.totalMinted).toBe(0n);
    expect(l.deposits).toBe(0n);
    expect(l.redeemed.isEmpty()).toBe(true);
    h.assertInvariant();
  });

  it('deposit locks the NIGHT and mints the same amount of wNIGHT to the caller', async () => {
    const h = await Harness.deploy();
    await h.deposit(100n);
    const l = h.ledger();
    expect(l.totalLocked).toBe(100n);
    expect(l.totalMinted).toBe(100n);
    expect(h.nightBalance).toBe(100n);
    expect(h.minted).toHaveLength(1);
    const [m] = h.minted;
    expect(m!.recipient).toBe(ALICE_COIN_PK);
    expect(m!.value).toBe(100n);
    expect(hex(m!.color)).toBe(h.color.hex);
    h.assertInvariant();
  });

  it('two deposits with the same client nonce still mint coins with distinct nonces', async () => {
    const h = await Harness.deploy();
    const nonce = bytes32();
    await h.deposit(10n, ALICE_COIN_PK, nonce);
    await h.deposit(10n, ALICE_COIN_PK, nonce);
    expect(h.minted).toHaveLength(2);
    expect(hex(h.minted[0]!.nonce)).not.toBe(hex(h.minted[1]!.nonce));
    h.assertInvariant();
  });

  it('happy path: A deposits 100, B redeems 100 to its unshielded address, totals return to 0', async () => {
    const h = await Harness.deploy();
    await h.deposit(100n, ALICE_COIN_PK);
    h.assertInvariant();
    // (A -> B shielded transfer happens wallet-to-wallet; no contract call.)
    const coin = h.coin(100n);
    await h.redeem(coin, BOB_ADDRESS, BOB_COIN_PK);
    expect(h.payouts.get(hex(BOB_ADDRESS.bytes))).toBe(100n);
    expect(h.wnightBurned).toBe(100n);
    const l = h.ledger();
    expect(l.totalLocked).toBe(0n);
    expect(l.totalMinted).toBe(0n);
    expect(h.nightBalance).toBe(0n);
    h.assertInvariant();
  });

  it('redeem receives the coin and burns that same coin in one transaction', async () => {
    const h = await Harness.deploy();
    await h.deposit(50n);
    const coin = h.coin(30n);
    await h.redeem(coin);
    const zswap = (h.sim.lastContext as any).zswapLocalStates[h.sim.address];
    // Output 1: the coin, created for this contract (receiveShielded).
    const toContract = zswap.outputs.find((o: any) => !o.recipient.is_left);
    expect(hex(toContract.recipient.right.bytes)).toBe(h.sim.address);
    expect(hex(toContract.coinInfo.nonce)).toBe(hex(coin.nonce));
    // Input: the contract spends that coin...
    expect(zswap.inputs).toHaveLength(1);
    expect(hex(zswap.inputs[0].nonce)).toBe(hex(coin.nonce));
    expect(zswap.inputs[0].value).toBe(30n);
    // ...to the burn address, in full (no change).
    const burned = zswap.outputs.filter((o: any) => o.recipient.is_left);
    expect(burned).toHaveLength(1);
    expect(hex(burned[0].recipient.left.bytes)).toBe(BURN_KEY);
    expect(burned[0].coinInfo.value).toBe(30n);
    h.assertInvariant();
  });

  it('keeps the invariant over a random sequence of deposits and partial redeems', async () => {
    const h = await Harness.deploy();
    const rnd = (n: number) => BigInt(1 + Math.floor(Math.random() * n));
    for (let i = 0; i < 40; i++) {
      const supply = h.ledger().totalMinted;
      if (supply === 0n || Math.random() < 0.5) {
        await h.deposit(rnd(1_000_000));
      } else {
        const v = supply < 2n ? supply : (rnd(Number(supply)) % supply) + 1n;
        await h.redeem(h.coin(v), { bytes: bytes32() });
      }
      h.assertInvariant();
    }
    // Drain completely.
    const rest = h.ledger().totalMinted;
    if (rest > 0n) await h.redeem(h.coin(rest));
    expect(h.ledger().totalLocked).toBe(0n);
    h.assertInvariant();
  });

  describe('rejections (state unchanged after each)', () => {
    const unchanged = async (h: Harness, fn: () => Promise<unknown>, message: string) => {
      const before = h.ledger();
      const [locked, minted, redeemed] = [before.totalLocked, before.totalMinted, before.redeemed.size()];
      await expectRejects(fn, message);
      const after = h.ledger();
      expect(after.totalLocked).toBe(locked);
      expect(after.totalMinted).toBe(minted);
      expect(after.redeemed.size()).toBe(redeemed);
      h.assertInvariant();
    };

    it('deposit of 0', async () => {
      const h = await Harness.deploy();
      await unchanged(h, () => h.deposit(0n), 'Deposit must be greater than zero');
    });

    it('deposit outside Uint<64> (negative, or above the protocol mint cap)', async () => {
      const h = await Harness.deploy();
      await unchanged(h, () => h.deposit(-1n), 'expected value of type Uint<0..18446744073709551616>');
      await unchanged(h, () => h.deposit(2n ** 64n), 'expected value of type Uint<0..18446744073709551616>');
    });

    it('deposit always asks the ledger for exactly the minted amount of NIGHT', async () => {
      // A wallet that pays less than `amount` cannot be simulated: the ledger
      // rejects an unbalanced transaction. What the contract controls is that
      // the NIGHT it demands equals the wNIGHT it mints, checked here.
      const h = await Harness.deploy();
      for (const amount of [1n, 7n, 1_000_000n, 2n ** 64n - 1n]) {
        const before = { night: h.nightBalance, minted: h.wnightMinted };
        await h.deposit(amount);
        expect(h.nightBalance - before.night).toBe(amount);
        expect(h.wnightMinted - before.minted).toBe(amount);
      }
      h.assertInvariant();
    });

    it('redeem more than was deposited', async () => {
      const h = await Harness.deploy();
      await unchanged(h, () => h.redeem(h.coin(1n)), 'Redeem exceeds wNIGHT supply');
      await h.deposit(100n);
      await unchanged(h, () => h.redeem(h.coin(101n)), 'Redeem exceeds wNIGHT supply');
    });

    it('redeem the same coin twice', async () => {
      const h = await Harness.deploy();
      await h.deposit(100n);
      const coin = h.coin(40n);
      await h.redeem(coin);
      // Supply (60) still covers it, so only the replay guard stops it.
      await unchanged(h, () => h.redeem(coin), 'Coin already redeemed');
      // Same nonce, different value is a different coin but the same replay key.
      await unchanged(h, () => h.redeem({ ...coin, value: 1n }), 'Coin already redeemed');
      expect(h.payouts.get(hex(BOB_ADDRESS.bytes))).toBe(40n);
    });

    it('redeem a coin of a different token type', async () => {
      const h = await Harness.deploy();
      await h.deposit(100n);
      // NIGHT's own color.
      await unchanged(h, () => h.redeem(h.coin(10n, new Uint8Array(32))), 'Coin is not wNIGHT');
      // A random token.
      await unchanged(h, () => h.redeem(h.coin(10n, bytes32())), 'Coin is not wNIGHT');
      // wNIGHT minted by a different wnight deployment (same domain, other address).
      const other = await Harness.deploy();
      expect(other.color.hex).not.toBe(h.color.hex);
      await unchanged(h, () => h.redeem(h.coin(10n, other.color.bytes)), 'Coin is not wNIGHT');
    });

    it('redeem a zero-value coin', async () => {
      const h = await Harness.deploy();
      await h.deposit(100n);
      await unchanged(h, () => h.redeem(h.coin(0n)), 'Redeem must be greater than zero');
    });
  });

  it('keeps shielded holders out of public state', async () => {
    const h = await Harness.deploy();
    const depositNonce = bytes32();
    await h.deposit(100n, ALICE_COIN_PK, depositNonce);
    const coin = h.coin(100n);
    await h.redeem(coin, BOB_ADDRESS, BOB_COIN_PK);
    const l = h.ledger();
    expect(Object.keys(l).sort()).toEqual(['deposits', 'redeemed', 'totalLocked', 'totalMinted']);
    // Control: the redeem coin's nonce is public by design (replay guard).
    expect(findInPublicState(l, coin.nonce)).toMatch(/^redeemed\[\d+\]$/);
    assertNotInPublicState(l, {
      aliceCoinPublicKey: Buffer.from(ALICE_COIN_PK, 'hex'),
      bobCoinPublicKey: Buffer.from(BOB_COIN_PK, 'hex'),
      depositNonce,
      mintedCoinNonce: h.minted[0]!.nonce,
      // Bob's unshielded address is public in the transaction (the NIGHT
      // payout), but the contract does not also store it.
      bobUnshieldedAddress: BOB_ADDRESS.bytes,
    });
  });
});
