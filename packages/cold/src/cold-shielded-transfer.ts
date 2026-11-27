// Run on the COLD machine, offline. Spends shielded coins: rebuilds the wallet's coins from a zswap feed made by
// hot-zswap-feed (public data only), builds a shielded transfer, proves it HERE with the zkir WebAssembly prover from
// local key files (a shielded spend's proof input holds the coin secret key, so it must never go to a proof server),
// checks it, and writes tx.hex for sponsor-submit, which adds the DUST fee and submits.
//
// Usage:
//   node dist/cold-shielded-transfer.js --address
//       print this wallet's shielded address (to fund it) and exit
//   node dist/cold-shielded-transfer.js <recipient mn_shield-addr_...> <amount> --token <64 hex> [--feed <file>] [--keys <dir>] [--out <file>]
//       amount: digits only, in the token's smallest unit. Defaults: cold-zswap.feed.json, prover-keys/, tx.hex
//
// Nothing here reaches a network: no indexer, node or proof server is configured, and nothing is fetched.
import { NETWORK, NETWORK_ID } from './config.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnightntwrk/wallet-sdk';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import * as zkir from '@midnightntwrk/zkir-v2';
import { deriveAndWipe, readSeed } from './keys.js';
import { elapsed, localStamp } from './timefmt.js';
import { COLD_SYNC_REMINDER } from './syncnotice.js';
import { assertFeedFor, feedDeadline, feedSummary, inspectFeed } from './zswapfeed.js';
import {
  type KeyPins, acceptKeyFiles, balancesOf, buildShieldedTransfer, diskName, missingKeyFiles, planSpend, proveAndCheck,
  rebuildFromFeed, spendTtl,
} from './coldshielded.js';

const startedAt = Date.now();
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v) throw new Error(`${name} needs a value.`);
  argv.splice(i, 2);
  return v;
};
const addressOnly = argv.includes('--address');
if (addressOnly) argv.splice(argv.indexOf('--address'), 1);
const tokenArg = flag('--token');
const feedPath = flag('--feed') ?? 'cold-zswap.feed.json';
const keysDir = flag('--keys') ?? 'prover-keys';
const outPath = flag('--out') ?? 'tx.hex';
const sha256hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const shieldedAddressOf = (k: ledgerV9.ZswapSecretKeys): string =>
  MidnightBech32m.encode(
    NETWORK_ID,
    new ShieldedAddress(ShieldedCoinPublicKey.fromHexString(k.coinPublicKey), ShieldedEncryptionPublicKey.fromHexString(k.encryptionPublicKey)),
  ).asString();

if (addressOnly) {
  const keys = deriveAndWipe(readSeed('COLD'));
  const zswap = ledgerV9.ZswapSecretKeys.fromSeed(keys.seeds.shielded);
  console.log(`Network:          ${NETWORK}`);
  console.log(`Shielded address: ${shieldedAddressOf(zswap)}`);
  console.log('Payments to this address (and this wallet\'s own spends) must be listed for hot-zswap-feed by transaction hash.');
  console.log(COLD_SYNC_REMINDER);
  zswap.clear();
  process.exit(0);
}

const [to, amountText] = argv;
if (!to || !amountText || !tokenArg) {
  throw new Error(
    'Usage: node dist/cold-shielded-transfer.js <recipient mn_shield-addr_...> <amount> --token <64 hex> [--feed <file>] [--keys <dir>] [--out <file>]\n' +
      '       node dist/cold-shielded-transfer.js --address',
  );
}
if (!/^[0-9a-f]{64}$/i.test(tokenArg)) throw new Error('--token needs the 64-character hex token type (for wNIGHT, its color).');
const tokenType = tokenArg.toLowerCase();
if (!/^[1-9][0-9]*$/.test(amountText)) throw new Error("The amount must be a positive whole number in the token's smallest unit, digits only.");
const amount = BigInt(amountText);

// ---- Untrusted inputs first, before any key is touched. ----
const feed = inspectFeed(readFileSync(feedPath, 'utf8'));
assertFeedFor(feed, NETWORK);
const ttl = spendTtl(feed, new Date()); // refuses a feed that is already too old by this machine's clock
// Decoding refuses an address of another network or kind.
const recipient = MidnightBech32m.parse(to.trim()).decode(ShieldedAddress, NETWORK_ID);

// Key files: accepted by SHA-256 only, against the pins the wallet SDK's prover client ships (ledger 9).
const pinsUrl = new URL('effect/KeyMaterial.js', import.meta.resolve('@midnightntwrk/wallet-sdk-prover-client'));
const { V9KeyMaterial } = (await import(pinsUrl.href)) as { V9KeyMaterial: KeyPins };
const entries: [string, Uint8Array][] = [];
for (const f of readdirSync(keysDir)) {
  const p = join(keysDir, f);
  if (f === 'SHA256SUMS' || !statSync(p).isFile() || statSync(p).size > 64 * 2 ** 20) continue;
  entries.push([f, new Uint8Array(readFileSync(p))]);
}
const { files, rejected } = acceptKeyFiles(entries, V9KeyMaterial, sha256hex);
if (rejected.length) console.warn(`Ignored ${rejected.length} file(s) in ${keysDir} that match no SDK pin: ${rejected.join(', ')}`);
const missing = missingKeyFiles(zkir, files);
if (missing.length) {
  throw new Error(`${keysDir} is missing: ${missing.map(diskName).join(', ')}. Run fetch-prover-keys on the online machine and copy the folder.`);
}

// ---- Keys, then the coins. ----
const keys = deriveAndWipe(readSeed('COLD'));
const zswap = ledgerV9.ZswapSecretKeys.fromSeed(keys.seeds.shielded);
// Clear the shielded secret keys however this ends (a refused plan, an error, Ctrl-C). Clearing twice throws; ignore it.
const clearKeys = () => {
  try {
    zswap.clear();
  } catch {
    /* already cleared */
  }
};
process.on('exit', clearKeys);
process.on('SIGINT', () => process.exit(130));
let rebuilt;
try {
  rebuilt = rebuildFromFeed(ledgerV9, zswap, feed);
} catch (err) {
  clearKeys();
  throw err;
}
const balances = balancesOf(rebuilt.coins);
const plan = planSpend(rebuilt.coins, tokenType, amount);
const ownAddress = shieldedAddressOf(zswap);
const toSelf = to.trim() === ownAddress;

console.log(`Started:   ${localStamp(new Date(startedAt))}`);
console.log('');
for (const line of feedSummary(feed)) console.log(line);
console.log('');
console.log(`Network:   ${NETWORK}`);
console.log(`From:      ${ownAddress}`);
console.log(`To:        ${to.trim()}${toSelf ? '  (this wallet itself)' : ''}`);
console.log('Coins found in the feed:');
if (balances.size === 0) console.log('  none');
for (const [type, b] of balances) console.log(`  ${type === tokenType ? '*' : ' '} ${type.slice(0, 8)}...${type.slice(-8)}: ${b.total} in ${b.count} coin(s)`);
console.log(`Token:     ${tokenType}`);
console.log(`Amount:    ${amount} (smallest units)`);
console.log(`Spends:    ${plan.inputs.length} coin(s) (${plan.inputs.map((c) => c.value).join(' + ')}), change back to this wallet: ${plan.change}`);
console.log(`Expires:   ${localStamp(ttl)}  (the feed's root is valid until ${localStamp(feedDeadline(feed))})`);
console.log(`Proving:   here, in WebAssembly: about two minutes per coin spent and per output (${plan.inputs.length} + ${plan.change > 0n ? 2 : 1}).`);
console.log('Fee:       paid by the hot machine\'s sponsor wallet');
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Check the recipient and amount above. Type SEND to build and prove: ');
rl.close();
if (answer.trim() !== 'SEND') {
  clearKeys();
  console.log('Cancelled. Nothing was built.');
  process.exit(1);
}

let proved;
try {
  const unproven = buildShieldedTransfer(
    ledgerV9,
    zswap,
    rebuilt,
    plan,
    { coinPublicKey: recipient.coinPublicKey.data.toString('hex'), encryptionPublicKey: recipient.encryptionPublicKey.data.toString('hex') },
    NETWORK,
    ttl,
  );
  console.log(`Proving (started ${localStamp(new Date())}); the machine is busy until it finishes...`);
  proved = await proveAndCheck(ledgerV9, zkir, unproven, files, NETWORK, () => Date.now());
} catch (err) {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}. Nothing was written.`);
  process.exit(1);
} finally {
  clearKeys();
}

if (Date.now() >= ttl.getTime()) {
  console.error(`Proving finished after the expiry (${localStamp(ttl)}). Nothing was written; make a new feed and try again.`);
  process.exit(1);
}
writeFileSync(outPath, proved.hex, { mode: 0o600 });
console.log(`Proved in ${elapsed(proved.proveMs)}; the ledger's verifier accepts the proofs.`);
console.log(`Wrote ${outPath} (${proved.bytes.length} bytes, sha256 ${sha256hex(proved.bytes)}).`);
console.log(`Take it to the hot machine and run sponsor-submit before ${localStamp(ttl)}.`);
console.log(`Finished:  ${localStamp(new Date())}  (total ${elapsed(Date.now() - startedAt)})`);
process.exit(0);
