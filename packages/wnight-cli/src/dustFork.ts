// Where Preprod's DUST event timeline crosses into ledger 9, found once and
// cached, so a fresh wallet starts its DUST sync there instead of replaying
// every ledger 8 DUST event from genesis (about a day through Blockfrost).
//
// Why this exists: Wallet SDK 2's `skipLedgerV8DustHistory` does the same
// search itself, but bounds each of its ~20 indexer requests to 10 s and the
// whole search to 30 s, and silently falls back to a full replay on any
// timeout. Blockfrost's Preprod indexer often takes 10-45 s to open a dust
// event subscription near the fork, so that search almost never finishes.
// Here each request may take up to DUST_FORK_PROBE_TIMEOUT_MS, is retried, and
// the answer is cached: the fork point never moves on a given chain.
//
// The search is the SDK's own (wallet-sdk-dust-wallet v2/Sync.js:
// findDustTimelineStart / narrowToBoundary), over the same subscription, then
// checked: the event at `cursor` is below the boundary and the first one after
// it is at or above it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { Logger } from 'pino';

/** Ledger 9 boundary, as protocol version (V9NativeForkVersion in wallet-sdk-abstractions). */
export const V9_BOUNDARY = 2_000_000;

export type DustForkStart = { cursor: bigint; version: bigint };

type Endpoints = { networkId: string; indexer: string; indexerWS: string };
type DustEvent = { id: number; version: number; maxId: number };
type Cached = {
  version: 1;
  networkId: string;
  indexer: string; // host only: the URL carries the Blockfrost key
  cursor: string;
  forkVersion: string;
  chain: { height: number; blockHash: string };
};

const STATE_DIR = fileURLToPath(new URL('../.wallet-state/', import.meta.url));
const PROBE_TIMEOUT_MS = Number(process.env['MIDNIGHT_DUST_FORK_PROBE_TIMEOUT_MS'] ?? 120_000);
const PROBE_ATTEMPTS = 3;

const QUERY = `subscription DustLedgerEvents($id: Int) {
  dustLedgerEvents(id: $id) { id maxId protocolVersion }
}`;

/** The first dust event from `id` on (the timeline's first for null), over graphql-transport-ws. */
function firstDustEventOnce(wsUrl: string, id: number | null): Promise<DustEvent> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, 'graphql-transport-ws');
    let settled = false;
    const finish = (err: Error | null, ev?: DustEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.close();
      if (err) reject(err);
      else resolve(ev!);
    };
    const timer = setTimeout(() => finish(new Error(`no dust event from ${id} within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; payload?: any };
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: QUERY, variables: { id } } }));
      } else if (msg.type === 'next') {
        const e = msg.payload?.data?.dustLedgerEvents;
        if (!e) return finish(new Error(`indexer error at ${id}: ${JSON.stringify(msg.payload?.errors ?? msg.payload)}`));
        finish(null, { id: Number(e.id), version: Number(e.protocolVersion), maxId: Number(e.maxId) });
      } else if (msg.type === 'error' || msg.type === 'complete') {
        finish(new Error(`indexer ${msg.type} at ${id}`));
      }
    });
    ws.on('unexpected-response', (_req, res) => finish(new Error(`indexer HTTP ${res.statusCode}`)));
    // Never echo the URL: it carries the Blockfrost project ID.
    ws.on('error', (e) => finish(new Error(`indexer connection failed: ${e.message.replace(/project_id=[^&\s]+/g, 'project_id=<redacted>')}`)));
    ws.on('close', () => finish(new Error(`indexer closed the connection at ${id}`)));
  });
}

async function firstDustEvent(wsUrl: string, id: number | null, logger: Logger): Promise<DustEvent> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await firstDustEventOnce(wsUrl, id);
    } catch (err) {
      if (attempt >= PROBE_ATTEMPTS) throw err;
      logger.debug(`DUST fork search: retrying event ${id} (${String(err)})`);
    }
  }
}

/** Same narrowing as the SDK's narrowToBoundary. */
async function search(wsUrl: string, logger: Logger): Promise<DustForkStart | undefined> {
  const first = await firstDustEvent(wsUrl, null, logger);
  const last = await firstDustEvent(wsUrl, first.maxId, logger);
  if (first.version >= V9_BOUNDARY || last.version < V9_BOUNDARY) return undefined; // chain never crossed it
  let low = first.id + 1;
  let high = last.id;
  let atHigh = last;
  let steps = 0;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const probed = await firstDustEvent(wsUrl, middle, logger);
    steps++;
    if (probed.version >= V9_BOUNDARY) {
      high = middle;
      atHigh = probed;
    } else {
      low = probed.id + 1;
    }
    logger.debug(`DUST fork search step ${steps}: [${low}, ${high}]`);
  }
  const start = { cursor: BigInt(low - 1), version: BigInt(atHigh.version) };
  // Check the definition: `cursor` is the last dust event below the boundary.
  const at = await firstDustEvent(wsUrl, low - 1, logger);
  const after = await firstDustEvent(wsUrl, low, logger);
  if (at.id !== low - 1 || at.version >= V9_BOUNDARY || after.version < V9_BOUNDARY) {
    throw new Error(`DUST fork search check failed at ${low - 1} (event ${at.id} v${at.version}, next v${after.version})`);
  }
  return start;
}

async function indexerQuery<T>(url: string, query: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? ((await res.json()) as { data?: T }).data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The DUST timeline's ledger 9 start for this network and indexer: from the
 * cache if its chain check passes, else by searching (a minute or a few). Undefined when the
 * chain never crossed ledger 9 or the search fails; the caller then keeps the
 * SDK's own (best-effort) search.
 */
export async function findDustForkStart(logger: Logger, env: Endpoints): Promise<DustForkStart | undefined> {
  if (process.env['MIDNIGHT_DUST_FORK_SEARCH'] === 'off') return undefined;
  const host = new URL(env.indexer).host;
  const file = join(STATE_DIR, `dust-fork-${env.networkId}-${host}.json`);

  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8')) as Cached;
      const data = await indexerQuery<{ block?: { hash?: string } | null }>(
        env.indexer,
        `{ block(offset: { height: ${Math.trunc(c.chain.height)} }) { hash } }`,
      );
      if (c.version === 1 && c.indexer === host && c.networkId === env.networkId && data?.block?.hash === c.chain.blockHash) {
        logger.info(`DUST: ledger 9 starts after dust event ${c.cursor} (cached); skipping ledger 8 DUST history.`);
        return { cursor: BigInt(c.cursor), version: BigInt(c.forkVersion) };
      }
      logger.warn(`Ignoring ${file}: chain check failed (network reset?). Searching again.`);
    } catch (err) {
      logger.warn(`Ignoring ${file} (${String(err)}). Searching again.`);
    }
  }

  logger.info('DUST: finding where ledger 9 starts on this chain (once per network; may take a few minutes)...');
  const t0 = Date.now();
  let start: DustForkStart | undefined;
  try {
    start = await search(env.indexerWS, logger);
  } catch (err) {
    logger.warn(`DUST fork search failed (${String(err)}); the DUST sync may replay ledger 8 history (slow).`);
    return undefined;
  }
  if (!start) return undefined;
  logger.info(`DUST: ledger 9 starts after dust event ${start.cursor} (found in ${Math.round((Date.now() - t0) / 1000)} s).`);

  const tip = await indexerQuery<{ block?: { height?: number; hash?: string } | null }>(env.indexer, '{ block { height hash } }');
  if (typeof tip?.block?.height === 'number' && typeof tip.block.hash === 'string') {
    const cached: Cached = {
      version: 1,
      networkId: env.networkId,
      indexer: host,
      cursor: start.cursor.toString(),
      forkVersion: start.version.toString(),
      chain: { height: tip.block.height, blockHash: tip.block.hash },
    };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(cached, null, 2) + '\n');
    renameSync(`${file}.tmp`, file);
  }
  return start;
}
