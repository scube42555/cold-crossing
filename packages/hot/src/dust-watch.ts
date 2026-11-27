// Run on the HOT machine. Asks the indexer which NIGHT coins generate DUST for a DUST address, using public data only:
// no seed, no secret key. It answers "has a registration started generating for this address?" and estimates how much
// DUST those coins have generated. It cannot show a balance: what was spent is only readable with the DUST secret key.
//
// Usage: node dist/dust-watch.js <DUST address>        (for example mn_dust_preprod1...)
// Env:   DUST_WATCH_TIMEOUT_SECONDS (default 120)
//
// Written from the wallet SDK 2.0.0 sources: the `DustGenerations` subscription the DUST wallet itself uses
// (wallet-sdk-dust-wallet v2/Sync.js).
// Verified (13 Nov 2026, Preprod, Blockfrost): the subscription is served, the stream ends by itself (5 messages in 5 s),
// a spent coin is reported as stopped, and the estimates are consistent with the 7-day cap of 5 DUST per NIGHT.
// SDK2-UNVERIFIED: the estimate has not been compared with a wallet's real DUST balance.
import { NETWORK, NETWORK_ID, hotEndpoints } from './config.js';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import { DustAddress, MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format';
import { BlockHash } from '@midnightntwrk/wallet-sdk/indexer-client';
import { QueryRunner } from '@midnightntwrk/wallet-sdk/indexer-client/effect';
import { collectGenerations } from './dustgen.js';
import { fromHex } from './hex.js';
import { elapsed, localStamp } from './timefmt.js';
import { formatDust, formatNight } from './txinfo.js';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

console.log(`Network: ${NETWORK}`);
const addressText = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!addressText) {
  console.error('Usage: node dist/dust-watch.js <DUST address>   (the address sponsor-submit prints as "Sponsor DUST address", or any other)');
  process.exit(1);
}
// Validate before use: a short, plain Bech32m string, then the SDK's own decoder, which refuses another network or type.
if (!/^mn_dust[a-z0-9_-]{0,20}1[02-9ac-hj-np-z]{20,200}$/.test(addressText)) {
  console.error('That is not a DUST address (they start with mn_dust). An unshielded address (mn_addr...) will not work here.');
  process.exit(1);
}
let owner: bigint;
try {
  owner = MidnightBech32m.parse(addressText).decode(DustAddress, NETWORK_ID).data;
} catch (e) {
  console.error(`The address could not be read as a ${NETWORK} DUST address: ${messageOf(e)}`);
  process.exit(1);
}
console.log(`DUST address: ${addressText}`);

const endpoints = hotEndpoints();
const startedAt = Date.now();

// The newest block: the subscription is asked for the state as of this block, as the DUST wallet does.
// An error object from the client can carry the request URL, which holds the token: print the status and message only.
const blockAnswer = await QueryRunner.runPromise(BlockHash, { offset: null }, { url: endpoints.indexerHttpUrl }).catch((e: unknown) => {
  const text = messageOf(e);
  console.error(`The indexer refused the block query: ${/forbidden|403/i.test(text) ? '403 Forbidden' : text.split('\n')[0]}`);
  if (/forbidden|403|unauthor|401/i.test(text)) {
    console.error('Blockfrost answers 403 when it does not accept the project token. Check that BLOCKFROST_PROJECT_ID in this terminal is the');
    console.error(`Midnight ${NETWORK} token, complete and with nothing extra (its length, never its value: echo "\${#BLOCKFROST_PROJECT_ID}").`);
  }
  process.exit(1);
});
const block = blockAnswer.block;
if (!block) {
  console.error('The indexer returned no block. Try again in a moment.');
  process.exit(1);
}
const blockTime = new Date(Number(block.timestamp)); // milliseconds (13 Nov 2026: matched the clock); only shown, not used in the estimate
console.log(`Block:        ${block.height}  (protocol version ${block.protocolVersion})`);

// The same subscription the DUST wallet sends, without the Merkle tree fields a wallet needs and a report does not.
const QUERY = `
  subscription DustGenerations($dustAddress: DustAddress!, $blockHash: HexEncoded!, $dtimeCutoffHeight: Int!) {
    dustGenerations(dustAddress: $dustAddress, blockHash: $blockHash, dtimeCutoffHeight: $dtimeCutoffHeight) {
      __typename
      ... on DustGenerationsItem { generationMtIndex owner value initialValue backingNight ctime transactionId transactionHash }
      ... on DustGenerationsProgress { highestIndex }
      ... on DustGenerationDtimeUpdateItem { generationMtIndex newDtime nightUtxoHash }
    }
  }`;

const timeoutSeconds = Number(process.env.DUST_WATCH_TIMEOUT_SECONDS ?? '120');
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error('DUST_WATCH_TIMEOUT_SECONDS must be a positive number.');
  process.exit(1);
}

/**
 * One subscription over the graphql-transport-ws protocol (what the SDK's client speaks), with Node's built-in
 * WebSocket. Resolves with every `dustGenerations` message once the server says the stream is complete.
 * The URL holds the Blockfrost token: it is never put in a message.
 */
const subscribe = (): Promise<{ messages: unknown[]; ended: 'complete' | 'timeout' }> =>
  new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(endpoints.indexerWsUrl, 'graphql-transport-ws');
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    // If the stream never says "complete", report what arrived and say so, rather than hang.
    const timer = setTimeout(() => finish(() => resolve({ messages, ended: 'timeout' })), timeoutSeconds * 1000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onerror = () => finish(() => reject(new Error('The connection to the indexer failed. Check the network, BLOCKFROST_PROJECT_ID and MIDNIGHT_NETWORK.')));
    ws.onclose = (event) =>
      finish(() => reject(new Error(`The indexer closed the connection before the answer was complete (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`)));
    ws.onmessage = (event) => {
      let msg: { type?: unknown; payload?: unknown };
      try {
        if (typeof event.data !== 'string') throw new Error('not text');
        msg = JSON.parse(event.data) as typeof msg;
      } catch {
        finish(() => reject(new Error('The indexer sent something that is not a protocol message.')));
        return;
      }
      if (msg.type === 'connection_ack') {
        ws.send(
          JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: { query: QUERY, variables: { dustAddress: addressText, blockHash: block.hash, dtimeCutoffHeight: 0 } },
          }),
        );
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (msg.type === 'next') {
        const payload = msg.payload as { data?: { dustGenerations?: unknown }; errors?: { message?: unknown }[] } | undefined;
        if (payload?.errors?.length) {
          const text = payload.errors.map((e) => String(e.message)).join('; ');
          finish(() => reject(new Error(`The indexer refused the query: ${text}`)));
        } else if (payload?.data?.dustGenerations !== undefined) {
          messages.push(payload.data.dustGenerations);
        }
      } else if (msg.type === 'error') {
        const errors = Array.isArray(msg.payload) ? (msg.payload as { message?: unknown }[]).map((e) => String(e.message)).join('; ') : 'no details';
        finish(() => reject(new Error(`The indexer refused the query: ${errors}`)));
      } else if (msg.type === 'complete') {
        finish(() => resolve({ messages, ended: 'complete' }));
      }
    };
  });

let result: Awaited<ReturnType<typeof subscribe>>;
try {
  result = await subscribe();
} catch (e) {
  console.error(messageOf(e));
  process.exit(1);
}

const { entries, ignored } = collectGenerations(result.messages);
console.log(`Asked in ${elapsed(Date.now() - startedAt)} (at ${localStamp(new Date())}); ${result.messages.length} message(s) from the indexer.`);
if (result.ended === 'timeout') {
  console.log(`Note: the indexer did not say the answer was complete within ${timeoutSeconds} s, so the list below may be partial (DUST_WATCH_TIMEOUT_SECONDS).`);
}
if (ignored > 0) console.log(`Note: ${ignored} message(s) had a shape this script does not know and were ignored.`);
console.log('');

if (entries.length === 0) {
  console.log('No NIGHT is generating DUST for this address as of that block.');
  console.log('If a registration was just made, generation starts only once it is on chain and the NIGHT has moved into a new coin; then run this again.');
  process.exit(0);
}

// The ledger's own formula for what an entry holds at a given time. Optional: if the shapes differ, the list is still shown.
let params: ledgerV9.DustParameters | undefined;
try {
  params = ledgerV9.LedgerParameters.deserialize(fromHex(block.ledgerParameters)).dust;
} catch (e) {
  console.log(`Note: the block's DUST parameters could not be read (${messageOf(e)}); no estimate is shown.`);
}
const now = new Date();
let total = 0n;
let estimated = 0;
console.log(`${entries.length} NIGHT coin(s) generate DUST for this address:`);
for (const e of entries) {
  let estimate = '';
  if (params) {
    try {
      const value = ledgerV9.updatedValue(e.ctime, e.initialValue, { value: e.nightValue, owner, nonce: e.backingNight as never, dtime: e.dtime }, now, params);
      total += value;
      estimated++;
      estimate = `  about ${formatDust(value)} DUST now`;
    } catch (err) {
      estimate = `  (no estimate: ${messageOf(err)})`;
    }
  }
  const state = e.dtime ? `stopped ${localStamp(e.dtime)} (its NIGHT was spent; the DUST decays)` : 'generating';
  console.log(`  ${formatNight(e.nightValue)} NIGHT  since ${localStamp(e.ctime)}  ${state}${estimate}`);
  console.log(`      NIGHT coin ${e.backingNight.slice(0, 16)}...  transaction ${e.transactionHash}`);
}
console.log('');
if (params && estimated > 0) {
  console.log(`Estimated DUST generated and still held, if none was spent: ${formatDust(total)} DUST`);
  console.log(`(Reaching the cap takes ${elapsed(Number(params.timeToCapSeconds) * 1000)} from registration. As of block time ${localStamp(blockTime)}.)`);
}
console.log('This is not a balance: DUST already spent on fees is not subtracted, and only the wallet that holds the DUST key can see that.');
process.exit(0);
