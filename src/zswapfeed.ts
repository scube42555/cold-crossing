// The zswap feed: what the hot machine hands the cold machine so it can spend shielded coins offline, with no key on the
// hot side. PURE MODULE, no SDK imports (it is unit tested in tests/).
//
// A shielded spend proves its coin is in the global coin-commitment Merkle tree at some recent root. The cold machine
// rebuilds that tree itself from public data only:
//   - the raw zswap events of the transactions that touched the cold wallet (payments in, and its own earlier spends,
//     whose change outputs are its coins too), which it decrypts with its own keys to find its coins;
//   - for every range of tree positions in between, a "collapsed update" from the indexer: a few hundred bytes that stand
//     for any number of other people's coins (measured: 279 bytes for all 71,782 Preprod positions).
// The hot machine learns only which transactions to fetch. It never sees a key, a coin or an amount of the cold wallet.
//
// Positions: a transaction covers tree positions [startIndex, endIndex) (end exclusive, as the indexer reports it); a
// collapsed segment covers [startIndex, endIndex] (both ends included, as the ledger and indexer define it). Segments must
// tile 0 .. tip.zswapEndIndex - 1 exactly, in order.

export const FEED_KIND = 'midnight-zswap-feed';
export const FEED_VERSION = 1;
/** Ledger 9's first protocol version: earlier zswap events cannot be read by the ledger 9 package. */
export const LEDGER9 = 2_000_000;
/** The ledger keeps a coin-tree root valid for one hour after a block (`past_roots`, 3600 s, zswap/src/ledger.rs). */
export const ROOT_LIFETIME_MS = 60 * 60 * 1000;
/** Refuse absurd feeds before parsing them: the realistic size is a few KB per transaction. */
export const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENTS = 2000;
const MAX_EVENTS_PER_TX = 1000;
const MAX_HEX_PER_ITEM = 1024 * 1024; // 512 KB of bytes

export type FeedTip = {
  height: number;
  hash: string; // 64 hex
  /** Block time, ms since the epoch. */
  timestamp: number;
  /** First free tree position after this block (exclusive end). */
  zswapEndIndex: number;
  /** The indexer's root encoding: a one-byte tag then 32 bytes, little-endian field element. */
  zswapMerkleTreeRoot: string;
  protocolVersion: number;
};

export type CollapsedSegment = { type: 'collapsed'; startIndex: number; endIndex: number; update: string };
export type TxSegment = {
  type: 'tx';
  hash: string;
  startIndex: number;
  endIndex: number;
  blockHeight: number;
  blockTimestamp: number;
  protocolVersion: number;
  /** Raw zswap ledger events of this transaction, hex, in order. */
  events: string[];
};
export type FeedSegment = CollapsedSegment | TxSegment;

export type Feed = {
  kind: typeof FEED_KIND;
  version: typeof FEED_VERSION;
  network: string;
  writtenAt: string;
  tip: FeedTip;
  segments: FeedSegment[];
};

const HEX = /^(?:[0-9a-f]{2})+$/;
const HASH = /^[0-9a-f]{64}$/;
const ROOT = /^[0-9a-f]{66}$/;
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const fail = (msg: string): never => {
  throw new Error(`Not a valid zswap feed: ${msg}`);
};

const hexItem = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length > MAX_HEX_PER_ITEM || !HEX.test(v)) fail(`${what} must be lowercase hex of at most ${MAX_HEX_PER_ITEM / 2} bytes`);
  return v as string;
};

/** A tx hash as typed or pasted: 64 hex, optionally 0x-prefixed. Returns lowercase without the prefix. */
export const normalizeTxHash = (s: string): string => {
  const h = s.trim().toLowerCase().replace(/^0x/, '');
  if (!HASH.test(h)) throw new Error(`"${s.slice(0, 80)}" is not a transaction hash (64 hex characters).`);
  return h;
};

/**
 * Read a list of transaction hashes, one per line; blank lines and lines starting with # are ignored. Duplicates are
 * dropped. Identifiers (as `sponsor-submit` prints them) are longer than 64 hex characters and are accepted as is.
 */
export const parseTxList = (text: string): string[] => {
  const out: string[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const v = line.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64,200}$/.test(v)) throw new Error(`Line ${i + 1} of the transaction list is not a hash or identifier.`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
};

/**
 * The gaps to fill with collapsed updates, given the transactions' ranges and the tip. Transactions must not overlap;
 * they are sorted here. Returns inclusive ranges.
 */
export const planGaps = (txs: readonly { startIndex: number; endIndex: number }[], tipEnd: number): [number, number][] => {
  const sorted = [...txs].sort((a, b) => a.startIndex - b.startIndex);
  const gaps: [number, number][] = [];
  let next = 0;
  for (const t of sorted) {
    if (t.startIndex < next) throw new Error(`Transactions overlap in the coin tree (position ${t.startIndex}).`);
    if (t.endIndex < t.startIndex) throw new Error('A transaction ends before it starts.');
    if (t.startIndex > next) gaps.push([next, t.startIndex - 1]);
    next = t.endIndex;
  }
  if (next > tipEnd) throw new Error(`A transaction ends at position ${next}, past the tip (${tipEnd}).`);
  if (tipEnd > next) gaps.push([next, tipEnd - 1]);
  return gaps;
};

/** Validate a feed's text completely before anything is decoded with the ledger. Everything here is untrusted input. */
export const inspectFeed = (text: string): Feed => {
  if (text.length > MAX_FEED_BYTES) fail(`larger than ${MAX_FEED_BYTES} bytes`);
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  if (typeof v !== 'object' || v === null) fail('not an object');
  if (v.kind !== FEED_KIND) fail(`kind must be "${FEED_KIND}"`);
  if (v.version !== FEED_VERSION) fail(`version must be ${FEED_VERSION} (this one is ${String(v.version)}); use matching versions on both machines`);
  if (typeof v.network !== 'string' || !/^[a-z]{1,20}$/.test(v.network)) fail('network missing');
  if (typeof v.writtenAt !== 'string' || v.writtenAt.length > 40) fail('writtenAt missing');

  const t = v.tip;
  if (typeof t !== 'object' || t === null) fail('tip missing');
  if (!isIndex(t.height) || !isIndex(t.timestamp) || !isIndex(t.zswapEndIndex) || !isIndex(t.protocolVersion)) fail('tip numbers invalid');
  if (typeof t.hash !== 'string' || !HASH.test(t.hash)) fail('tip hash invalid');
  if (typeof t.zswapMerkleTreeRoot !== 'string' || !ROOT.test(t.zswapMerkleTreeRoot)) fail('tip root invalid');
  if (t.protocolVersion < LEDGER9) fail(`tip is at protocol version ${t.protocolVersion}, below ledger 9`);

  if (!Array.isArray(v.segments) || v.segments.length === 0 || v.segments.length > MAX_SEGMENTS) fail('segments missing or too many');
  let next = 0;
  let txCount = 0;
  const segments: FeedSegment[] = [];
  for (const [i, s] of v.segments.entries()) {
    const where = `segment ${i + 1}`;
    if (typeof s !== 'object' || s === null) fail(`${where} is not an object`);
    if (!isIndex(s.startIndex) || !isIndex(s.endIndex)) fail(`${where} positions invalid`);
    if (s.startIndex !== next) fail(`${where} starts at position ${s.startIndex}, expected ${next}: segments must cover the tree in order`);
    if (s.type === 'collapsed') {
      if (s.endIndex < s.startIndex) fail(`${where} ends before it starts`);
      segments.push({ type: 'collapsed', startIndex: s.startIndex, endIndex: s.endIndex, update: hexItem(s.update, `${where} update`) });
      next = s.endIndex + 1;
    } else if (s.type === 'tx') {
      if (s.endIndex < s.startIndex) fail(`${where} ends before it starts`);
      if (typeof s.hash !== 'string' || !HASH.test(s.hash)) fail(`${where} hash invalid`);
      if (!isIndex(s.blockHeight) || !isIndex(s.blockTimestamp) || !isIndex(s.protocolVersion)) fail(`${where} block fields invalid`);
      if (s.protocolVersion < LEDGER9) fail(`${where} is a ledger 8 transaction (protocol ${s.protocolVersion}); its events cannot be replayed`);
      if (!Array.isArray(s.events) || s.events.length === 0 || s.events.length > MAX_EVENTS_PER_TX) fail(`${where} events missing`);
      segments.push({
        type: 'tx',
        hash: s.hash,
        startIndex: s.startIndex,
        endIndex: s.endIndex,
        blockHeight: s.blockHeight,
        blockTimestamp: s.blockTimestamp,
        protocolVersion: s.protocolVersion,
        events: s.events.map((e: unknown, j: number) => hexItem(e, `${where} event ${j + 1}`)),
      });
      next = s.endIndex;
      txCount++;
    } else {
      fail(`${where} has unknown type`);
    }
  }
  if (next !== t.zswapEndIndex) fail(`segments end at position ${next}, but the tip's tree ends at ${t.zswapEndIndex}`);
  if (txCount === 0) fail('no transactions: the cold wallet would find no coins');
  return {
    kind: FEED_KIND,
    version: FEED_VERSION,
    network: v.network,
    writtenAt: v.writtenAt,
    tip: {
      height: t.height,
      hash: t.hash,
      timestamp: t.timestamp,
      zswapEndIndex: t.zswapEndIndex,
      zswapMerkleTreeRoot: t.zswapMerkleTreeRoot,
      protocolVersion: t.protocolVersion,
    },
    segments,
  };
};

export const assertFeedFor = (feed: Feed, network: string): void => {
  if (feed.network !== network) throw new Error(`The feed is for ${feed.network}, not ${network}.`);
};

/**
 * The latest time a spend built from this feed can be included: the root the cold wallet proves against is the tip's,
 * and the ledger keeps it valid for an hour after the tip block (longer only if no shielded transaction lands after it,
 * which cannot be known in advance).
 */
export const feedDeadline = (feed: Feed): Date => new Date(feed.tip.timestamp + ROOT_LIFETIME_MS);

/** The ledger's root (a field element) in the indexer's encoding minus its one-byte tag: 32 bytes little-endian, hex. */
export const rootToHexLE = (root: bigint): string => {
  if (root < 0n || root >= 1n << 256n) throw new Error('Root out of range.');
  const be = root.toString(16).padStart(64, '0');
  return be.match(/../g)!.reverse().join('');
};

/** Does the rebuilt tree's root equal the tip's? The indexer prefixes a tag byte; compare the 32 bytes after it. */
export const rootMatches = (root: bigint | undefined, indexerRoot: string): boolean =>
  root !== undefined && ROOT.test(indexerRoot) && indexerRoot.slice(2) === rootToHexLE(root);

export const feedSummary = (feed: Feed): string[] => {
  const txs = feed.segments.filter((s): s is TxSegment => s.type === 'tx');
  const collapsed = feed.segments.length - txs.length;
  return [
    `Network:      ${feed.network}`,
    `Tip:          block ${feed.tip.height}, ${new Date(feed.tip.timestamp).toISOString()}, tree positions 0..${feed.tip.zswapEndIndex - 1}`,
    `Transactions: ${txs.length} (${txs.map((t) => `${t.hash.slice(0, 12)}... block ${t.blockHeight}`).join('; ')})`,
    `Gaps:         ${collapsed} collapsed update(s)`,
    `Spend by:     ${feedDeadline(feed).toISOString()} (one hour after the tip block)`,
  ];
};
