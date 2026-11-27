// Run on the HOT machine, by the hot page's server (tools/hot_server.py). Reads the three files that cross the air gap
// and prints what they hold as one JSON object: nothing is synced, nothing is contacted, and no secret is read.
//
// Usage: node dist/hot-inspect.js [cold-public.json] [cold-unshielded.snapshot.json] [tx.hex]
//
// It answers three questions for the page: whose address is being watched, what the snapshot holds, and what tx.hex
// does (the same plan sponsor-submit prints). It also counts how many of the coins tx.hex spends are still in the
// snapshot: after a fresh snapshot, none left means the transfer landed.
import { NETWORK, NETWORK_ID } from './config.js';
import { existsSync, readFileSync } from 'node:fs';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import { UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { fromHex } from './hex.js';
import { sha256hex } from './mqr.js';
import { inspectSnapshot, type SnapshotInfo } from './snapshot.js';
import { describePlan, readTransaction } from './txinfo.js';

const [publicFile = 'cold-public.json', snapshotFile = 'cold-unshielded.snapshot.json', txFile = 'tx.hex'] = process.argv.slice(2);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The value qr-send and qr-decode print for a file, so the page can show the same thing. */
const digest = (bytes: Uint8Array): string => sha256hex(bytes).slice(0, 16);

type Out = Record<string, unknown>;
const out: Out = { network: NETWORK, coldPublic: null, snapshot: null, tx: null };

if (existsSync(publicFile)) {
  try {
    const raw = readFileSync(publicFile);
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.address !== 'string') throw new Error('it has no "address".');
    out.coldPublic = {
      address: parsed.address,
      network: typeof parsed.network === 'string' ? parsed.network : null,
      sha: digest(raw),
      problem: parsed.network === NETWORK ? null : `It is for network "${String(parsed.network)}", not "${NETWORK}".`,
    };
  } catch (e) {
    out.coldPublic = { error: `${publicFile} could not be read: ${messageOf(e)}` };
  }
}

let snapshot: SnapshotInfo | undefined;
if (existsSync(snapshotFile)) {
  try {
    const raw = readFileSync(snapshotFile);
    const info = inspectSnapshot(raw.toString('utf8'));
    out.snapshot = {
      address: info.address,
      network: info.network,
      availableCount: info.availableCount,
      pendingCount: info.pendingCount,
      balances: [...info.available].map(([type, value]) => [type, value.toString()]),
      protocolVersion: info.protocolVersion ?? null,
      writtenBy: info.writtenBy ?? null,
      bytes: raw.length,
      sha: digest(raw),
    };
    if (info.network === NETWORK) snapshot = info; // as sponsor-submit does: a snapshot for another network is not used
  } catch (e) {
    out.snapshot = { error: `${snapshotFile} could not be read: ${messageOf(e)}` };
  }
}

if (existsSync(txFile)) {
  try {
    const raw = readFileSync(txFile);
    const hex = raw.toString('utf8').trim();
    // Validate before parsing: only a plain hex string is accepted, as in sponsor-submit.
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('it is not a hex string.');
    const bytes = fromHex(hex);
    const tx = ledgerV9.Transaction.deserialize<ledgerV9.SignatureEnabled, ledgerV9.Proof, ledgerV9.Binding>('signature', 'proof', 'binding', bytes);
    const details = readTransaction(tx as never, {
      addressOfKey: (key) => ledgerV9.addressFromKey(key as never),
      bech32: (addressHex) => UnshieldedAddress.codec.encode(NETWORK_ID, new UnshieldedAddress(Buffer.from(addressHex, 'hex'))).asString(),
    });
    const senders = [...new Set(details.inputs.map((i) => i.address))];
    const inSnapshot =
      snapshot && senders.length === 1 && senders[0] === snapshot.address
        ? details.inputs.filter((i) => snapshot.utxos.some((u) => u.intentHash === i.intentHash && u.outputNo === i.outputNo)).length
        : null; // null: no snapshot that could tell (missing, or for another wallet or network)
    out.tx = {
      bytes: bytes.length,
      sha: digest(raw),
      senders,
      inputs: details.inputs.length,
      inputsInSnapshot: inSnapshot,
      expires: details.expires ? details.expires.toISOString() : null,
      expired: details.expires ? details.expires.getTime() <= Date.now() : false,
      plan: describePlan(details, snapshot),
    };
  } catch (e) {
    out.tx = { error: `${txFile} could not be read: ${messageOf(e)}` };
  }
}

process.stdout.write(`${JSON.stringify(out)}\n`);
