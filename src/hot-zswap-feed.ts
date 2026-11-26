// Run on the HOT machine. Writes the zswap feed the cold machine needs to spend shielded coins offline
// (src/zswapfeed.ts explains it). Needs no seed and no key: everything it fetches is public.
//
// Usage: node dist/hot-zswap-feed.js [<tx hash or identifier> ...] [--list <file>] [--out <file>]
//   The transactions are those that touched the cold wallet: payments into its shielded address, and its own earlier
//   shielded spends (sponsor-submit appends those to the list file itself). Default list: cold-shielded-txs.txt if it
//   exists (or COLD_TX_LIST). Default output: cold-zswap.feed.json (or FEED_FILE).
//
// Before writing, it rebuilds the tree from the feed with a throwaway key and checks the root against the tip's, so a
// feed that would not work on the cold machine is caught here.
import { NETWORK, hotEndpoints } from './config.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import { fromHex } from './hex.js';
import { printSponsorNotice } from './syncnotice.js';
import {
  FEED_KIND, FEED_VERSION, LEDGER9, type Feed, type FeedSegment, type FeedTip, type TxSegment,
  feedSummary, inspectFeed, normalizeTxHash, parseTxList, planGaps, rootMatches,
} from './zswapfeed.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v) throw new Error(`${name} needs a value.`);
  argv.splice(i, 2);
  return v;
};
const listFile = flag('--list') ?? process.env.COLD_TX_LIST ?? 'cold-shielded-txs.txt';
const outFile = flag('--out') ?? process.env.FEED_FILE ?? 'cold-zswap.feed.json';
printSponsorNotice(); // early: the feed is valid for an hour, and sponsor-submit needs the sponsor synced

const ids: string[] = [];
for (const a of argv) {
  const v = a.toLowerCase().replace(/^0x/, '');
  ids.push(v.length === 64 ? normalizeTxHash(v) : parseTxList(v)[0]!);
}
if (existsSync(listFile)) {
  const fromList = parseTxList(readFileSync(listFile, 'utf8'));
  console.log(`Read ${fromList.length} transaction(s) from ${listFile}.`);
  for (const v of fromList) if (!ids.includes(v)) ids.push(v);
}
if (ids.length === 0) {
  throw new Error(`No transactions. Give the hashes of the transactions that paid the cold wallet, or list them in ${listFile} (one per line).`);
}

const { indexerHttpUrl } = hotEndpoints(); // holds the Blockfrost token on preprod/mainnet: never print it
const gql = async <T>(query: string): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(`The indexer could not be reached (${err instanceof Error ? err.name : 'error'}). Check the network and BLOCKFROST_PROJECT_ID.`);
  }
  if (!res.ok) throw new Error(`The indexer answered HTTP ${res.status}.`);
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
  if (body.errors?.length) throw new Error(`The indexer refused the query: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  return body.data as T;
};

console.log(`Network: ${NETWORK}`);
const { block } = await gql<{ block: FeedTip & { hash: string } }>('{ block { height hash timestamp zswapEndIndex zswapMerkleTreeRoot protocolVersion } }');
const tip: FeedTip = {
  height: block.height,
  hash: block.hash.toLowerCase().replace(/^0x/, ''),
  timestamp: Number(block.timestamp),
  zswapEndIndex: block.zswapEndIndex,
  zswapMerkleTreeRoot: block.zswapMerkleTreeRoot.toLowerCase().replace(/^0x/, ''),
  protocolVersion: block.protocolVersion,
};
if (tip.protocolVersion < LEDGER9) throw new Error(`The chain tip is at protocol version ${tip.protocolVersion}, below ledger 9.`);

type IndexerTx = {
  hash: string;
  protocolVersion: number;
  block: { height: number; timestamp: number };
  zswapStartIndex?: number;
  zswapEndIndex?: number;
  transactionResult?: { status: string };
  zswapLedgerEvents?: { id: number; raw: string }[];
};
const TX_FIELDS =
  'hash protocolVersion block { height timestamp } ... on RegularTransaction { zswapStartIndex zswapEndIndex transactionResult { status } zswapLedgerEvents { id raw } }';

const txs: TxSegment[] = [];
for (const id of ids) {
  const offset = id.length === 64 ? `hash: "${id}"` : `identifier: "${id}"`;
  const { transactions } = await gql<{ transactions: IndexerTx[] }>(`{ transactions(offset: { ${offset} }) { ${TX_FIELDS} } }`);
  const t = transactions[0];
  if (!t) throw new Error(`The indexer does not know transaction ${id.slice(0, 16)}... (not on chain yet, or another network).`);
  if (t.zswapStartIndex === undefined || t.zswapEndIndex === undefined || !t.zswapLedgerEvents) {
    throw new Error(`Transaction ${t.hash.slice(0, 16)}... is not a regular transaction with shielded parts.`);
  }
  if (t.protocolVersion < LEDGER9) throw new Error(`Transaction ${t.hash.slice(0, 16)}... is from ledger 8; coins from before the fork cannot be spent this way.`);
  const status = t.transactionResult?.status ?? 'UNKNOWN';
  if (status !== 'SUCCESS' && status !== 'PARTIAL_SUCCESS') throw new Error(`Transaction ${t.hash.slice(0, 16)}... did not succeed (${status}).`);
  if (t.zswapLedgerEvents.length === 0) {
    console.warn(`Skipping ${t.hash.slice(0, 16)}...: it has no zswap events (no shielded coins in or out).`);
    continue;
  }
  const hash = t.hash.toLowerCase().replace(/^0x/, '');
  if (txs.some((x) => x.hash === hash)) continue;
  txs.push({
    type: 'tx',
    hash,
    startIndex: t.zswapStartIndex,
    endIndex: t.zswapEndIndex,
    blockHeight: t.block.height,
    blockTimestamp: Number(t.block.timestamp),
    protocolVersion: t.protocolVersion,
    events: [...t.zswapLedgerEvents].sort((a, b) => a.id - b.id).map((e) => e.raw.toLowerCase()),
  });
}
txs.sort((a, b) => a.startIndex - b.startIndex);

const gaps = planGaps(txs, tip.zswapEndIndex);
const collapsed = new Map<number, FeedSegment>();
for (const [start, end] of gaps) {
  const { zswapMerkleTreeCollapsedUpdate: u } = await gql<{ zswapMerkleTreeCollapsedUpdate: { update: string; protocolVersion: number } }>(
    `{ zswapMerkleTreeCollapsedUpdate(startIndex: ${start}, endIndex: ${end}) { update protocolVersion } }`,
  );
  collapsed.set(start, { type: 'collapsed', startIndex: start, endIndex: end, update: u.update.toLowerCase().replace(/^0x/, '') });
}
// On a tie, the transaction goes first: one with no new coins (only spends) takes no positions, and the gap after it
// starts where it does.
const segments: FeedSegment[] = [...collapsed.values(), ...txs].sort((a, b) => a.startIndex - b.startIndex || (a.type === 'tx' ? -1 : 1));

const feed: Feed = { kind: FEED_KIND, version: FEED_VERSION, network: NETWORK, writtenAt: new Date().toISOString(), tip, segments };
const text = JSON.stringify(feed, null, 1) + '\n';
inspectFeed(text); // the cold machine's own check, run here first

// Rebuild with a throwaway key: the tree is public, only coin discovery needs the cold key.
const throwaway = ledgerV9.ZswapSecretKeys.fromSeed(new Uint8Array(randomBytes(32)));
let state = new ledgerV9.ZswapLocalState();
for (const s of segments) {
  state =
    s.type === 'collapsed'
      ? state.applyCollapsedUpdate(ledgerV9.MerkleTreeCollapsedUpdate.deserialize(fromHex(s.update)))
      : state.replayEvents(throwaway, s.events.map((e) => ledgerV9.Event.deserialize(fromHex(e))));
}
throwaway.clear();
if (state.firstFree !== BigInt(tip.zswapEndIndex) || !rootMatches(state.merkleTreeRoot, tip.zswapMerkleTreeRoot)) {
  throw new Error('Rebuilding the tree from this feed did not reach the tip root. Nothing was written; run it again.');
}

writeFileSync(outFile, text, { mode: 0o600 });
for (const line of feedSummary(feed)) console.log(line);
console.log(`Check:        rebuilt tree root matches the tip (${state.firstFree} positions).`);
console.log(`Wrote ${outFile} (${Buffer.byteLength(text)} bytes). Copy it to the cold machine and build the spend well before the time above.`);
