// Run on the HOT machine. Takes the finalized transaction from the cold machine, adds DUST to pay the fee
// from the sponsor wallet, and submits it.
//
// Usage: node dist/sponsor-submit.js [tx.hex] [--dry-run] [--sync-anyway]
// --dry-run balances and finalizes (proving locally) but does not submit.
// With no saved sponsor state it stops before syncing if tx.hex expires within 3 hours (run hot:sponsor-sync first);
// --sync-anyway syncs from scratch regardless.
//
// Wallet SDK 2. Before asking you to confirm it shows who sends and receives, the From wallet's balance and coins (from
// cold-unshielded.snapshot.json, or SNAPSHOT_FILE, if present), the sponsor's addresses and DUST balance, and an estimate of the DUST
// fee. Nothing is balanced or locked until you type SUBMIT. Afterwards it shows the fee the final transaction actually declares.
// It prints the start and finish time so you can see how long each run takes.
// It checks that the proof server answers (GET /version) before the sync and again before asking for SUBMIT.
//
// Verified (11 Nov 2026, Preprod): adoptTransaction, validateTransaction, estimateTransactionFee,
// balanceFinalizedTransaction, signRecipe, finalizeRecipe and submitTransaction exercised end to end.
import { ADDITIONAL_FEE_OVERHEAD, hotEndpoints, NETWORK, NETWORK_ID } from './config.js';
import { checkProofServer, proofServerHelp } from './proofcheck.js';
import { checkColdPublicNetwork } from './crosscheck.js';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import * as ledgerV9 from '@midnightntwrk/wallet-sdk/ledger/v9';
import { DustAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { deriveAndWipe, readSeed } from './keys.js';
import { fromHex } from './hex.js';
import { beep } from './beep.js';
import { describePlan, declaredDustFee, formatDust, readTransaction, type TxDetails } from './txinfo.js';
import { inspectSnapshot, type SnapshotInfo } from './snapshot.js';
import { elapsed, localStamp } from './timefmt.js';
import { buildWallet, describePhase, loadWalletState, onLedger9, saveWalletState, submitWithRetry, syncAndSave, walletStateFile } from './wallet.js';

/** Format an error without swallowing a blank message: show _tag, message and cause. */
const fmtErr = (err: unknown): string => {
  if (err === null || err === undefined) return '(no details)';
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e['_tag'] === 'string') parts.push(`[${e['_tag']}]`);
  const msg = err instanceof Error ? err.message : '';
  if (msg) parts.push(msg);
  if (e['cause'] != null) parts.push(`cause: ${fmtErr(e['cause'])}`);
  return parts.length ? parts.join(' — ') : (err instanceof Error ? err.constructor.name : String(err));
};

// Time first, so a run can be timed from its first line to its last, however it ends.
const startedAt = new Date();
console.log(`Started:  ${localStamp(startedAt)}`);
process.on('exit', () => console.log(`Finished: ${localStamp(new Date())}  (total ${elapsed(Date.now() - startedAt.getTime())})`));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// `npm run hot:sponsor-submit --dry-run` hands --dry-run to npm, not to this script, which would then submit for real.
// npm records it in this variable. Stop rather than guess what was meant.
if (process.env.npm_config_dry_run === 'true' && !dryRun) {
  console.error('npm took --dry-run for itself, so this script did not receive it and would submit for real.');
  console.error('Put the flag after a lone "--":  npm run hot:sponsor-submit -- --dry-run   (or run: node dist/sponsor-submit.js --dry-run)');
  process.exit(1);
}
if (process.env.npm_config_sync_anyway === 'true' && !args.includes('--sync-anyway')) {
  console.error('npm took --sync-anyway for itself. Put it after a lone "--":  npm run hot:sponsor-submit -- --sync-anyway');
  process.exit(1);
}
const txFile = args.find((a) => !a.startsWith('--')) ?? 'tx.hex';
/** With no saved sponsor state, refuse a tx.hex that expires sooner than this (a first sync takes hours). --sync-anyway overrides. */
const FIRST_SYNC_ALLOWANCE_MS = 3 * 3600_000;

// Stop before any file is parsed or any network is contacted if cold-public.json is for another network.
checkColdPublicNetwork(NETWORK);
console.log(`Network: ${NETWORK}`);

// Validate before parsing: only a plain hex string is accepted.
const hex = readFileSync(txFile, 'utf8').trim();
if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error(`${txFile} is not a hex string.`);
const bytes = fromHex(hex);
console.log(`Read ${txFile}: ${bytes.length} bytes.`);

// For the plan display only: the wallet's own handle hides the transaction, so read the same bytes with the ledger 9 package.
const decodeFinalized = (b: Uint8Array) =>
  ledgerV9.Transaction.deserialize<ledgerV9.SignatureEnabled, ledgerV9.Proof, ledgerV9.Binding>('signature', 'proof', 'binding', b);

// The From wallet's coins and balance come from the snapshot that hot-watch wrote; skip them if there is none.
let snapshot: SnapshotInfo | undefined;
const snapshotFile = process.env.SNAPSHOT_FILE ?? 'cold-unshielded.snapshot.json';
if (existsSync(snapshotFile)) {
  try {
    snapshot = inspectSnapshot(readFileSync(snapshotFile, 'utf8'));
    if (snapshot.network !== NETWORK) {
      console.warn(`Ignoring ${snapshotFile}: it is for network "${snapshot.network}", not "${NETWORK}".`);
      snapshot = undefined;
    }
  } catch (err) {
    console.warn(`Ignoring ${snapshotFile}: ${fmtErr(err)}`);
  }
}

// A shielded transfer from cold-shielded-transfer: its amounts and addresses are encrypted, so only the shape can be shown.
// After submission its identifier is added to the cold wallet's transaction list, because its change output is a cold
// coin that the next zswap feed must include.
const coldTxList = process.env.COLD_TX_LIST ?? 'cold-shielded-txs.txt';
let shielded = { spends: 0, outputs: 0 };
try {
  const decoded = decodeFinalized(bytes);
  const offers = [decoded.guaranteedOffer, ...(decoded.fallibleOffer ? [...decoded.fallibleOffer.values()] : [])];
  for (const o of offers) {
    if (!o) continue;
    shielded.spends += o.inputs.length;
    shielded.outputs += o.outputs.length;
  }
  if (shielded.spends + shielded.outputs > 0) {
    console.log(`Shielded part: ${shielded.spends} coin(s) spent, ${shielded.outputs} output(s). Amounts and addresses are encrypted;`);
    console.log('               the cold machine showed them before it proved the transaction.');
  }
} catch {
  shielded = { spends: 0, outputs: 0 };
}

/** What to do about an expired tx.hex. Nothing was submitted, so nothing was spent; a shielded spend also needs a new feed. */
const expiredMessage = (expires: Date): string[] => [
  `tx.hex expired at ${localStamp(expires)}. Nothing was submitted; the coins it would spend are unspent.`,
  ...(shielded.spends > 0
    ? [
        'To try again: on this machine run `npm run hot:zswap-feed` (a new feed; the clock starts there), run',
        'cold-shielded-transfer on the cold machine with it, and bring the new tx.hex back here before it expires.',
      ]
    : ['To try again: build and sign a new transfer on the cold machine (cold-transfer or the cold page), then run this.']),
];

// Show what this transaction does before the slow sync, so you can stop early if it is not what you expect.
// If the contents cannot be read, say so and carry on: the cold machine already showed you what it signed.
// details is kept in scope so the TTL can be checked again after the sync (tx.hex may expire during a long sync).
let details: TxDetails | undefined;
try {
  details = readTransaction(decodeFinalized(bytes) as never, {
    addressOfKey: (key) => ledgerV9.addressFromKey(key as never), // the key is the decoded transaction's own SignatureVerifyingKey
    bech32: (addressHex) =>
      UnshieldedAddress.codec.encode(NETWORK_ID, new UnshieldedAddress(Buffer.from(addressHex, 'hex'))).asString(),
  });
  console.log('');
  for (const line of describePlan(details, snapshot)) console.log(line);
  console.log('');
  if (details.expires && details.expires.getTime() <= Date.now()) {
    expiredMessage(details.expires).forEach((l) => console.error(l));
    process.exit(1);
  }
} catch (err) {
  console.warn(`Could not read the transaction's contents (${fmtErr(err)}); the addresses are not shown.`);
}

// The proof server is only used after SUBMIT, to prove the sponsor's DUST spend. Check it now, before the sync, so a server
// that is not running (or a PROOF_SERVER_URL not set in this terminal) fails in seconds and not after tx.hex's time is spent.
const proofServerUrl = hotEndpoints().proofServer;
const proofServerIsSet = (process.env.PROOF_SERVER_URL ?? '').trim() !== '';
{
  const check = await checkProofServer(proofServerUrl);
  if (!check.ok) {
    proofServerHelp(check.reason, proofServerIsSet).forEach((l) => console.error(l));
    console.error('Nothing was done; tx.hex is kept. Run this again once the proof server answers.');
    beep(2);
    process.exit(1);
  }
  console.log(`Proof server: reachable (version ${check.version})${proofServerIsSet ? ', from PROOF_SERVER_URL' : ''}.`);
}

const keys = deriveAndWipe(readSeed('SPONSOR'));
console.log(`Sponsor:  ${keys.unshieldedKeystore.getBech32Address().asString()}`);
const stateFile = walletStateFile(keys);

const saved = await loadWalletState(stateFile);
if (saved) {
  console.log(`Resuming sponsor wallet from ${stateFile} (last saved ${localStamp(statSync(stateFile).mtime)}).`);
} else {
  console.log(`No saved state (${stateFile}): this sponsor has not been synced in this folder.`);
  // A first sync takes hours. A transaction that expires before it ends would be wasted, and an expired shielded spend
  // means a new feed and a new proof on the cold machine. Keep tx.hex and sync first, separately.
  const left = details?.expires ? details.expires.getTime() - Date.now() : undefined;
  if (left !== undefined && left < FIRST_SYNC_ALLOWANCE_MS && !args.includes('--sync-anyway')) {
    console.error(`tx.hex expires at ${localStamp(details!.expires!)}, in ${elapsed(left)}: too soon for a first sync, which takes hours.`);
    console.error('Nothing was done; tx.hex is kept. Sync the sponsor first, then run this again before the expiry:');
    console.error('  npm run hot:sponsor-sync');
    console.error('(If this is not the sponsor you meant, check SPONSOR_MNEMONIC. To try anyway, add --sync-anyway.)');
    process.exit(1);
  }
  console.log('Syncing from scratch, which is slow (hours). Next time run `npm run hot:sponsor-sync` early, at the first step.');
}
const wallet = await buildWallet(keys, saved);

// An unsynced sponsor gets error 170 (InvalidDustSpendProof), so wait for a full sync. Progress is printed and saved
// as it goes (and on Ctrl-C), so an interrupted first sync resumes; the synced state is kept even if anything after this
// fails (an expired tx.hex, a refused transaction).
const synced = await syncAndSave(wallet, stateFile);
if (!saved) beep(3); // alert that the long first sync is done

// A long sync can outlast the TTL. Reject now rather than let adoptTransaction fail with a blank error.
if (details?.expires && details.expires.getTime() <= Date.now()) {
  expiredMessage(details.expires).forEach((l) => console.error(l));
  await wallet.stop();
  beep(2);
  process.exit(1);
}

const dustBefore = synced.dust.balance(new Date());
console.log(`Sponsor DUST address: ${String(DustAddress.encodePublicKey(NETWORK_ID, synced.dust.publicKey))}`);
console.log(`Sponsor DUST balance: ${formatDust(dustBefore)} DUST`);

// The cap and refill rate explain why a small fee can leave no visible dent. This reads internal wallet state,
// so it is optional: if the shape differs it prints nothing.
let refillRate: bigint | undefined; // SPECK per second while below the cap
try {
  const dust = synced.dust as unknown as {
    availableCoins: { dtime?: unknown; maxCap: bigint }[];
    state: { state: { params: { timeToCapSeconds: bigint | number } } };
  };
  const cap = dust.availableCoins.filter((c) => c.dtime === undefined).reduce((t, c) => t + c.maxCap, 0n);
  const timeToCap = BigInt(dust.state.state.params.timeToCapSeconds);
  if (cap > 0n && timeToCap > 0n) {
    refillRate = cap / timeToCap;
    console.log(`Sponsor DUST cap:     ${formatDust(cap)} DUST, regenerating about ${formatDust(refillRate)} DUST per second below the cap.`);
  }
} catch {
  /* cap not available in this version */
}

// The wallets must have crossed to ledger 9 by now, or anything built here is a ledger 8 transaction.
console.log(`Protocol phase: ${describePhase(synced.protocol)}`);
if (!onLedger9(synced.protocol)) {
  console.error('The sponsor wallets are not settled on ledger 9, so they would refuse a ledger 9 transaction. Stopping before anything is balanced.');
  await saveWalletState(wallet, stateFile);
  await wallet.stop();
  beep(2);
  process.exit(1);
}

// Hand the bytes to the wallet. It stamps them with the version it is acting at and refuses bytes written by the other ledger version.
let userTx;
try {
  userTx = wallet.adoptTransaction(bytes, 'Finalized');
} catch (err) {
  console.error(`The wallet refused ${txFile}: ${fmtErr(err)}`);
  console.error('Most likely it was built at another protocol version (ledger 8 instead of 9). Take a new snapshot with hot-watch and build it again.');
  await wallet.stop();
  beep(2);
  process.exit(1);
}

// Structural check before anything is balanced: this is what catches a tampered tx.hex early, with a clear message.
try {
  await wallet.validateTransaction(userTx, { flags: { enforceBalancing: false, verifySignatures: true, enforceLimits: false } });
  console.log('Validation: tx.hex is well formed and its signatures verify.');
} catch (err) {
  console.error(`${txFile} failed validation: ${fmtErr(err)}`);
  await wallet.stop();
  beep(2);
  process.exit(1);
}

const ttl = new Date(Date.now() + 60 * 60 * 1000);
try {
  const estimate = await wallet.estimateTransactionFee(userTx, { ttl });
  console.log(`DUST fee estimate: ${formatDust(estimate)} DUST (the SDK's estimate; the fee the final transaction declares is shown after signing).`);
  console.log(`Sponsor DUST after: about ${formatDust(dustBefore - estimate)} DUST if the estimate holds.`);
} catch (err) {
  console.log(`DUST fee estimate not available (${fmtErr(err)}).`);
}
console.log('');

// Again, in case the server went away during a long sync: after SUBMIT it is the last thing the transaction needs.
{
  const check = await checkProofServer(proofServerUrl);
  if (!check.ok) {
    proofServerHelp(check.reason, proofServerIsSet).forEach((l) => console.error(l));
    console.error('Nothing was balanced or locked; tx.hex is kept and the sponsor state is saved. Run this again once it answers.');
    await saveWalletState(wallet, stateFile);
    await wallet.stop();
    beep(2);
    process.exit(1);
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
beep(); // the prompt is ready
const reminder = setInterval(beep, 20_000); // keep reminding until you answer
const answer = await rl.question(
  `The sponsor wallet will pay the fee${dryRun ? ' (dry run, no submission)' : ' and submit this transaction'}. Type SUBMIT to continue: `,
);
clearInterval(reminder);
rl.close();
if (answer.trim() !== 'SUBMIT') {
  console.log('Cancelled. Nothing was balanced or locked.');
  await wallet.stop();
  process.exit(1);
}

// May wait up to two minutes for the DUST trees to reach a recent block, then rejects with a Wallet.Sync error.
const proveStarted = Date.now();
const recipe = await wallet.balanceFinalizedTransaction(userTx, { ttl, tokenKindsToBalance: ['dust'] });
const signed = await wallet.signRecipe(recipe, keys.unshieldedKeystore.signDataAsync);
const finalized = await wallet.finalizeRecipe(signed); // proves the sponsor's DUST spend via the proof server
console.log(`Balanced, signed and proved in ${elapsed(Date.now() - proveStarted)}.`);

// What the final transaction really declares: read from the bytes, because the wallet's handle hides the transaction.
try {
  const declared = declaredDustFee(decodeFinalized(finalized.serialize()) as never);
  console.log(`Declared fee in the final transaction: ${formatDust(declared)} DUST. The wallet takes all of it and gets none back.`);
  if (declared >= ADDITIONAL_FEE_OVERHEAD) {
    console.log(`          = ${formatDust(ADDITIONAL_FEE_OVERHEAD)} DUST extra overhead (config.ts) + ${declared - ADDITIONAL_FEE_OVERHEAD} SPECK for the ledger's price and margin.`);
  }
} catch (err) {
  console.log(`Could not read the declared fee from the final transaction (${fmtErr(err)}).`);
}

// The last structural check, with everything now in place. Reuses the block data fetched while balancing.
await wallet.validateTransaction(finalized, {
  flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true },
  blockData: Reflect.get(recipe, 'blockData') as never,
});

if (dryRun) {
  try {
    await wallet.revert(finalized); // a dry run must not leave the sponsor's DUST locked
    console.log('Dry run complete: balanced and finalized, not submitted. The sponsor\'s DUST was released.');
  } catch (err) {
    console.log(`Dry run complete, not submitted. Releasing the DUST failed (${fmtErr(err)}); it frees up when the transaction expires.`);
  }
} else {
  const txId = await submitWithRetry(wallet, finalized);
  console.log(`Submitted transaction ${txId}`);
  if (shielded.spends > 0) {
    appendFileSync(coldTxList, `# ${new Date().toISOString()} cold shielded spend (sponsor-submit)\n${txId}\n`, { mode: 0o600 });
    console.log(`Added it to ${coldTxList}: hot-zswap-feed includes it next time, so the cold wallet sees its change.`);
  }
}

await saveWalletState(wallet, stateFile);
await wallet.stop();
beep(2); // finished
process.exit(0);
