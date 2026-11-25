// The cold shielded spend's core (src/coldshielded.ts) against a real Preprod zswap feed (public chain data), offline.
// Every key is random and thrown away. Proving is not run here (minutes in WebAssembly); see README section 13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as L from '@midnightntwrk/wallet-sdk/ledger/v9';
import { buildShieldedTransfer, planSpend, rebuildFromFeed, spendTtl } from '../src/coldshielded.js';
import { inspectFeed } from '../src/zswapfeed.js';

const text = readFileSync(new URL('../../tests/fixtures/zswap-feed-preprod.json', import.meta.url), 'utf8');
const freshKeys = () => L.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
const TOKEN = 'c0'.repeat(32);

test('a stranger rebuilds the public tree to the tip root and finds no coins', () => {
  const keys = freshKeys();
  const rebuilt = rebuildFromFeed(L, keys, inspectFeed(text));
  assert.equal(rebuilt.coins.length, 0);
  assert.equal(rebuilt.state.firstFree, BigInt(inspectFeed(text).tip.zswapEndIndex));
  keys.clear();
});

test('a feed whose pieces do not add up to the tip root is refused', () => {
  const v = JSON.parse(text);
  // Swap the collapsed update of one gap for another gap's: positions still tile, the tree does not.
  const gaps = v.segments.filter((s: { type: string }) => s.type === 'collapsed');
  [gaps[1].update, gaps[2].update] = [gaps[2].update, gaps[1].update];
  const keys = freshKeys();
  assert.throws(() => rebuildFromFeed(L, keys, inspectFeed(JSON.stringify(v))));
  keys.clear();
  const w = JSON.parse(text);
  w.tip.zswapMerkleTreeRoot = '73' + '00'.repeat(32);
  const keys2 = freshKeys();
  assert.throws(() => rebuildFromFeed(L, keys2, inspectFeed(JSON.stringify(w))), /root is not the tip's root/);
  keys2.clear();
});

test('planSpend prefers one covering coin, else the largest coins', () => {
  const c = (value: bigint, i: number) => ({ type: TOKEN, nonce: i.toString(16).padStart(64, '0'), value, mt_index: BigInt(i) });
  const coins = [c(5n, 1), c(40n, 2), c(12n, 3), c(30n, 4)];
  assert.deepEqual(planSpend(coins, TOKEN, 10n).inputs.map((x) => x.value), [12n]);
  assert.equal(planSpend(coins, TOKEN, 10n).change, 2n);
  assert.deepEqual(planSpend(coins, TOKEN, 60n).inputs.map((x) => x.value), [40n, 30n]);
  assert.equal(planSpend(coins, TOKEN, 87n).inputs.length, 4);
  assert.throws(() => planSpend(coins, TOKEN, 88n), /less than/);
  assert.throws(() => planSpend(coins, TOKEN, 0n), /greater than zero/);
  assert.throws(() => planSpend(coins, TOKEN, 87n, 3), /at most 3/);
});

test('the built transfer has the planned spends, outputs and expiry, and balances', () => {
  const keys = freshKeys();
  const feed = inspectFeed(text);
  const rebuilt = rebuildFromFeed(L, keys, feed);
  // Give this throwaway wallet a coin at the next free position (local only; the chain never sees it).
  const state = rebuilt.state.insertCoin(keys, L.createShieldedCoinInfo(TOKEN, 1_000n));
  const coins = [...state.coins];
  assert.equal(coins.length, 1);
  const plan = planSpend(coins, TOKEN, 300n);
  const ttl = new Date(feed.tip.timestamp + 30 * 60_000);
  const recipient = freshKeys();
  const tx = buildShieldedTransfer(
    L,
    keys,
    { state, coins },
    plan,
    { coinPublicKey: recipient.coinPublicKey, encryptionPublicKey: recipient.encryptionPublicKey },
    'preprod',
    ttl,
  );
  const offer = tx.guaranteedOffer!;
  assert.equal(offer.inputs.length, 1);
  assert.equal(offer.outputs.length, 2); // recipient and change
  assert.equal(offer.deltas.get(TOKEN) ?? 0n, 0n);
  const intents = [...(tx.intents?.values() ?? [])];
  assert.equal(intents.length, 1);
  assert.equal(intents[0]!.ttl.getTime(), ttl.getTime());
  keys.clear();
  recipient.clear();
});

test('spendTtl refuses a stale feed and leaves a margin before the root expires', () => {
  const feed = inspectFeed(text);
  const early = new Date(feed.tip.timestamp + 5 * 60_000);
  assert.equal(spendTtl(feed, early).getTime(), feed.tip.timestamp + 50 * 60_000);
  assert.throws(() => spendTtl(feed, new Date(feed.tip.timestamp + 55 * 60_000)), /too old/);
});
