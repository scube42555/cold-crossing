import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FEED_KIND, MAX_FEED_BYTES, ROOT_LIFETIME_MS, feedDeadline, inspectFeed, normalizeTxHash, parseTxList, planGaps,
  rootMatches, rootToHexLE,
} from '../src/zswapfeed.js';

// A real feed written by hot-zswap-feed on Preprod (public chain data only: two shielded transactions and the tree gaps).
const fixture = readFileSync(new URL('../../tests/fixtures/zswap-feed-preprod.json', import.meta.url), 'utf8');
const base = () => JSON.parse(fixture);
const withChange = (f: (v: any) => void) => {
  const v = base();
  f(v);
  return JSON.stringify(v);
};

test('the real Preprod feed passes', () => {
  const feed = inspectFeed(fixture);
  assert.equal(feed.kind, FEED_KIND);
  assert.equal(feed.network, 'preprod');
  assert.equal(feed.segments.length, 5);
  assert.equal(feed.segments.filter((s) => s.type === 'tx').length, 2);
  assert.equal(feedDeadline(feed).getTime(), feed.tip.timestamp + ROOT_LIFETIME_MS);
});

test('segments must tile the tree in order up to the tip', () => {
  assert.throws(() => inspectFeed(withChange((v) => v.segments.splice(2, 1))), /starts at position/);
  assert.throws(() => inspectFeed(withChange((v) => (v.tip.zswapEndIndex += 1))), /segments end at position/);
  assert.throws(() => inspectFeed(withChange((v) => v.segments.reverse())), /starts at position/);
  assert.throws(() => inspectFeed(withChange((v) => (v.segments[0].endIndex = -1))), /positions invalid/);
});

test('a feed with no transaction, or a ledger 8 one, is refused', () => {
  assert.throws(
    () =>
      inspectFeed(
        withChange((v) => {
          v.segments = [{ type: 'collapsed', startIndex: 0, endIndex: v.tip.zswapEndIndex - 1, update: 'ab' }];
        }),
      ),
    /no transactions/,
  );
  assert.throws(() => inspectFeed(withChange((v) => (v.segments[1].protocolVersion = 1000300))), /ledger 8/);
  assert.throws(() => inspectFeed(withChange((v) => (v.tip.protocolVersion = 1000300))), /below ledger 9/);
});

test('untrusted fields are checked before use', () => {
  assert.throws(() => inspectFeed('not json'), /not JSON/);
  assert.throws(() => inspectFeed(withChange((v) => (v.kind = 'other'))), /kind/);
  assert.throws(() => inspectFeed(withChange((v) => (v.version = 2))), /version must be 1/);
  assert.throws(() => inspectFeed(withChange((v) => (v.segments[1].events[0] = 'ZZ'))), /lowercase hex/);
  assert.throws(() => inspectFeed(withChange((v) => (v.segments[1].events[0] = 'ABCD'))), /lowercase hex/);
  assert.throws(() => inspectFeed(withChange((v) => (v.segments[0].update = 'abc'))), /lowercase hex/);
  assert.throws(() => inspectFeed(withChange((v) => (v.segments[1].hash = 'xyz'))), /hash invalid/);
  assert.throws(() => inspectFeed(withChange((v) => (v.tip.zswapMerkleTreeRoot = '00'))), /root invalid/);
  assert.throws(() => inspectFeed(withChange((v) => (v.segments[1].type = 'other'))), /unknown type/);
  assert.throws(() => inspectFeed(' '.repeat(MAX_FEED_BYTES + 1)), /larger than/);
});

test('planGaps fills everything between and after the transactions', () => {
  assert.deepEqual(planGaps([{ startIndex: 10, endIndex: 12 }, { startIndex: 5, endIndex: 7 }], 20), [
    [0, 4],
    [7, 9],
    [12, 19],
  ]);
  assert.deepEqual(planGaps([{ startIndex: 0, endIndex: 3 }], 3), []);
  // A spend-only transaction takes no positions.
  assert.deepEqual(planGaps([{ startIndex: 4, endIndex: 4 }], 6), [
    [0, 3],
    [4, 5],
  ]);
  assert.throws(() => planGaps([{ startIndex: 0, endIndex: 5 }, { startIndex: 3, endIndex: 6 }], 10), /overlap/);
  assert.throws(() => planGaps([{ startIndex: 0, endIndex: 11 }], 10), /past the tip/);
});

test('roots compare in the indexer encoding (tag byte, then 32 bytes little-endian)', () => {
  // Measured on Preprod: the ledger root of a tree rebuilt from a collapsed update, and the indexer's root for that tip.
  const ledgerRoot = 3801967911441358924778427808811771376903727922109504248263515808814890399855n;
  const indexerRoot = '736fb84a42e7ada8074b21d6a517ae778a08e721af6eb8ea1848db4b9e6bd66708';
  assert.equal(rootToHexLE(ledgerRoot), indexerRoot.slice(2));
  assert.equal(rootMatches(ledgerRoot, indexerRoot), true);
  assert.equal(rootMatches(ledgerRoot + 1n, indexerRoot), false);
  assert.equal(rootMatches(undefined, indexerRoot), false);
});

test('transaction lists and hashes', () => {
  const h = 'ab'.repeat(32);
  const id = '00' + 'cd'.repeat(32);
  assert.deepEqual(parseTxList(`# comment\n\n${h}\n0x${h.toUpperCase()}\n${id}\n`), [h, id]);
  assert.throws(() => parseTxList('not a hash'), /Line 1/);
  assert.equal(normalizeTxHash(` 0x${h.toUpperCase()} `), h);
  assert.throws(() => normalizeTxHash('12'), /not a transaction hash/);
});
