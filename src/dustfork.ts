// Where the chain's DUST event timeline crosses into ledger 9, found once and cached, so a FRESH sponsor wallet starts its
// DUST sync there instead of replaying every ledger 8 DUST event from genesis (the slow part of a first sync: hours through
// Blockfrost). Ported from the wnight project (cli/src/dustFork.ts), where it is in use on Preprod.
//
// Why not the SDK's own `skipLedgerV8DustHistory`: it does the same search but bounds the whole search to 30 s and falls
// back to a full replay on any timeout, and Blockfrost often takes 10-45 s to open one dust event subscription near the fork.
// Here each request may take DUST_FORK_PROBE_TIMEOUT_MS (default 120 s), is retried, and the answer is cached: the fork
// point never moves on a given chain. The search is the SDK's (wallet-sdk-dust-wallet Sync.js: findDustTimelineStart),
// over the same subscription, then checked: the event at `cursor` is below the boundary and the next one is at or above it.
//
// Public chain data only. The indexer URL can carry the Blockfrost token: it is never printed (src/redact.ts also scrubs it).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Ledger 9 boundary as a protocol version (V9NativeForkVersion). */
export const V9_BOUNDARY = 2_000_000;

export type DustForkStart = { cursor: bigint; version: bigint };
type DustEvent = { id: number; version: number; maxId: number };
type Cached = { version: 1; network: string; indexer: string; cursor: string; forkVersion: string; chain: { height: number; blockHash: string } };

const PROBE_TIMEOUT_MS = Number(process.env.DUST_FORK_PROBE_TIMEOUT_MS ?? 120_000);
const PROBE_ATTEMPTS = 3;
const QUERY = 'subscription DustLedgerEvents($id: Int) { dustLedgerEvents(id: $id) { id maxId protocolVersion } }';
const scrub = (s: string) => s.replace(/project_id=[^&\s"]+/g, 'project_id=<redacted>');

/** The first dust event from `id` on (the timeline's first for null), over graphql-transport-ws. */
const firstDustEventOnce = (wsUrl: string, id: number | null): Promise<DustEvent> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, 'graphql-transport-ws');
    let settled = false;
    const finish = (err: Error | null, ev?: DustEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(ev!);
    };
    const timer = setTimeout(() => finish(new Error(`no dust event from ${id} within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} })));
    ws.addEventListener('message', (m) => {
      let msg: { type: string; payload?: any };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return finish(new Error('indexer sent something that is not JSON'));
      }
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: QUERY, variables: { id } } }));
      } else if (msg.type === 'next') {
        const e = msg.payload?.data?.dustLedgerEvents;
        if (!e) return finish(new Error(`indexer error at ${id}: ${scrub(JSON.stringify(msg.payload?.errors ?? msg.payload)).slice(0, 200)}`));
        finish(null, { id: Number(e.id), version: Number(e.protocolVersion), maxId: Number(e.maxId) });
      } else if (msg.type === 'error' || msg.type === 'complete') {
        finish(new Error(`indexer ${msg.type} at ${id}`));
      }
    });
    ws.addEventListener('error', () => finish(new Error('indexer connection failed')));
    ws.addEventListener('close', () => finish(new Error(`indexer closed the connection at ${id}`)));
  });

const firstDustEvent = async (wsUrl: string, id: number | null): Promise<DustEvent> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await firstDustEventOnce(wsUrl, id);
    } catch (err) {
      if (attempt >= PROBE_ATTEMPTS) throw err;
    }
  }
};

/** Same narrowing as the SDK's narrowToBoundary. Undefined when the chain never crossed the boundary. */
const search = async (wsUrl: string): Promise<DustForkStart | undefined> => {
  const first = await firstDustEvent(wsUrl, null);
  const last = await firstDustEvent(wsUrl, first.maxId);
  if (first.version >= V9_BOUNDARY || last.version < V9_BOUNDARY) return undefined;
  let low = first.id + 1;
  let high = last.id;
  let atHigh = last;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const probed = await firstDustEvent(wsUrl, middle);
    if (probed.version >= V9_BOUNDARY) {
      high = middle;
      atHigh = probed;
    } else {
      low = probed.id + 1;
    }
  }
  const start = { cursor: BigInt(low - 1), version: BigInt(atHigh.version) };
  const at = await firstDustEvent(wsUrl, low - 1);
  const after = await firstDustEvent(wsUrl, low);
  if (at.id !== low - 1 || at.version >= V9_BOUNDARY || after.version < V9_BOUNDARY) {
    throw new Error(`check failed at ${low - 1} (event ${at.id} v${at.version}, next v${after.version})`);
  }
  return start;
};

const indexerQuery = async <T>(url: string, query: string): Promise<T | undefined> => {
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
};

/**
 * The DUST timeline's ledger 9 start: from `dust-fork-<network>-<indexer host>.json` in the current folder if its chain
 * check passes, else by searching (a minute or a few) and caching. Undefined when the chain never crossed ledger 9, the
 * search fails, or DUST_FORK_SEARCH=off; the DUST wallet then starts as before (replaying from genesis).
 */
export const findDustForkStart = async (network: string, indexerHttpUrl: string, indexerWsUrl: string): Promise<DustForkStart | undefined> => {
  if (process.env.DUST_FORK_SEARCH === 'off') return undefined;
  const host = new URL(indexerHttpUrl).host;
  const file = `dust-fork-${network}-${host}.json`;
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8')) as Cached;
      const data = await indexerQuery<{ block?: { hash?: string } | null }>(
        indexerHttpUrl,
        `{ block(offset: { height: ${Math.trunc(c.chain.height)} }) { hash } }`,
      );
      if (c.version === 1 && c.indexer === host && c.network === network && /^\d+$/.test(c.cursor) && data?.block?.hash === c.chain.blockHash) {
        console.log(`DUST: ledger 9 starts after dust event ${c.cursor} (cached in ${file}); skipping the ledger 8 DUST history.`);
        return { cursor: BigInt(c.cursor), version: BigInt(c.forkVersion) };
      }
      console.warn(`Ignoring ${file}: its chain check failed (network reset?). Searching again.`);
    } catch (err) {
      console.warn(`Ignoring ${file} (${err instanceof Error ? err.message : String(err)}). Searching again.`);
    }
  }
  console.log('DUST: finding where ledger 9 starts on this chain (once per network; can take a few minutes)...');
  const t0 = Date.now();
  let start: DustForkStart | undefined;
  try {
    start = await search(indexerWsUrl);
  } catch (err) {
    console.warn(`DUST fork search failed (${scrub(err instanceof Error ? err.message : String(err))}); the DUST sync replays ledger 8 history (slow).`);
    return undefined;
  }
  if (!start) return undefined;
  console.log(`DUST: ledger 9 starts after dust event ${start.cursor} (found in ${Math.round((Date.now() - t0) / 1000)} s).`);
  const tip = await indexerQuery<{ block?: { height?: number; hash?: string } | null }>(indexerHttpUrl, '{ block { height hash } }');
  if (typeof tip?.block?.height === 'number' && typeof tip.block.hash === 'string') {
    const cached: Cached = {
      version: 1,
      network,
      indexer: host,
      cursor: start.cursor.toString(),
      forkVersion: start.version.toString(),
      chain: { height: tip.block.height, blockHash: tip.block.hash },
    };
    writeFileSync(`${file}.tmp`, JSON.stringify(cached, null, 2) + '\n');
    renameSync(`${file}.tmp`, file);
  }
  return start;
};
