// Measure a real shielded spend proved by the WebAssembly prover (no proof server), and check it on chain.
//
//   npm run wasm-transfer -- [amount] [mn_shield-addr_preprod1...]
//     amount in wNIGHT, default 1; recipient default: wallet B itself (a self-transfer, so nothing leaves B)
//
// Wallet B sends wNIGHT with an ordinary shielded transfer and pays the fee from its own DUST. Every proof (the wNIGHT
// spend, the recipient and change outputs, the DUST spend) is made in-process by the SDK's WASM prover, the prover a
// browser on an offline machine would run. Acceptance on Preprod shows those proofs are valid, not just locally checked.
// This is a step toward a shielded cold flow (see the cold-hot project's prover lab); here everything runs online.
import * as Rx from 'rxjs';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk';
import { Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import {
  formatNight, loadDeployment, logBalances, logger, openWallet, warnIfOtherWalletUnsynced, parseNight, parseShieldedAddress, preprodConfig, runScript,
} from './wallets.js';
import { resetWasmProofEvents, wasmProofEvents } from './wasmProver.js';

const USAGE = 'Usage: npm run wasm-transfer -- [amount in wNIGHT, default 1] [mn_shield-addr_preprod1..., default wallet B itself]';
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

await runScript(async (opened) => {
  if (process.env['MIDNIGHT_PROVER'] !== 'wasm') throw new Error('Run this through `npm run wasm-transfer`, which sets MIDNIGHT_PROVER=wasm.');
  const config = preprodConfig();
  const amount = parseNight(process.argv[2] ?? '1');
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  const { wnightColor } = loadDeployment(config);

  warnIfOtherWalletUnsynced('B', config);
  const b = await openWallet('B', config);
  opened.push(b);
  const own = b.getShieldedAddress();
  const receiverAddress = process.argv[3] ? parseShieldedAddress(process.argv[3], config.networkId, USAGE) : own;
  const toSelf = MidnightBech32m.encode(config.networkId, receiverAddress).asString() === MidnightBech32m.encode(config.networkId, own).asString();

  const before = await b.wallet.waitForSyncedState();
  const have = before.shielded.balances[wnightColor] ?? 0n;
  const coins = before.shielded.availableCoins.filter((c) => c.coin.type === wnightColor);
  logger.info(`wallet B: ${formatNight(have)} wNIGHT in ${coins.length} coin(s): ${coins.map((c) => formatNight(c.coin.value)).join(', ')}`);
  if (have < amount) throw new Error(`Wallet B holds ${formatNight(have)} wNIGHT, less than ${formatNight(amount)}`);
  logger.info(`Sending ${formatNight(amount)} wNIGHT ${toSelf ? 'from B to itself' : `to ${process.argv[3]}`} (shielded; fee from B's DUST).`);
  if (!toSelf) {
    // Early, so the slow sync can run while this proves: the cold-hot shielded flow ends with sponsor-submit.
    logger.info(
      "If this pays a cold wallet for cold-crossing's shielded flow: that flow ends with sponsor-submit, which needs the " +
        'sponsor wallet synced. Start `npm run hot:sponsor-sync` in the cold-crossing folder now, so it is ready.',
    );
  }

  resetWasmProofEvents();
  const t0 = performance.now();
  const recipe = await b.wallet.transferTransaction(
    [{ type: 'shielded', outputs: [{ type: wnightColor, receiverAddress, amount }] }],
    { ttl: ttlOneHour(), payFees: true },
  );
  const tBuilt = performance.now();
  const signed = await b.wallet.signRecipe(recipe, (payload) => b.unshieldedKeystore.signDataAsync(payload));
  logger.info('Proving with the WASM prover (first run downloads ~20 MB of key files from the SDK key host)...');
  const tProve = performance.now();
  const finalized = await b.wallet.finalizeRecipe(signed);
  const tProved = performance.now();

  // What was proved: read the finished transaction.
  const tx = Transaction.deserialize('signature', 'proof', 'binding', finalized.serialize());
  const offers = [tx.guaranteedOffer, ...(tx.fallibleOffer ? [...tx.fallibleOffer.values()] : [])].filter((o) => o !== undefined);
  const spends = offers.reduce((n, o) => n + o.inputs.length, 0);
  const outputs = offers.reduce((n, o) => n + o.outputs.length, 0);
  const transients = offers.reduce((n, o) => n + o.transients.length, 0);
  const dustSpends = [...(tx.intents?.values() ?? [])].reduce((n, i) => n + (i.dustActions?.spends.length ?? 0), 0);
  const asked = wasmProofEvents().filter((e) => e.what.startsWith('key '));
  const byCircuit = new Map<string, number>();
  for (const e of asked) byCircuit.set(e.what.slice(4), (byCircuit.get(e.what.slice(4)) ?? 0) + 1);

  logger.info(`built in ${secs(tBuilt - t0)}; proved in ${secs(tProved - tProve)} (WASM, proofs run in parallel workers)`);
  logger.info(`transaction: ${finalized.serialize().length} bytes; ${spends} shielded spend(s), ${outputs} output(s), ${transients} transient(s), ${dustSpends} DUST spend(s)`);
  logger.info(`proofs by circuit (one key lookup each): ${[...byCircuit].map(([c, n]) => `${c} x${n}`).join(', ')}`);
  for (const e of wasmProofEvents()) logger.debug(`  +${secs(e.atMs)} ${e.what}`);

  // Print the identifier first: the SDK's submit waits on the node connection, which Blockfrost sometimes drops, and a
  // run stuck there must still leave you the ID to find the transaction (and to list it for a cold wallet's feed).
  const [identifier] = tx.identifiers();
  logger.info(`submitting; transaction identifier ${identifier}`);
  const SUBMIT_WAIT_MS = 3 * 60_000;
  const txId = await Promise.race([
    b.wallet.submitTransaction(finalized),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `submit did not return within ${SUBMIT_WAIT_MS / 60_000} minutes (node connection?). The transaction may still ` +
                `have landed: look up identifier ${identifier} on the indexer or explorer before sending again.`,
            ),
          ),
        SUBMIT_WAIT_MS,
      ),
    ),
  ]);
  logger.info(`submitted ${txId}; waiting for it on chain...`);

  // Confirmed when the spent wNIGHT coin(s) are gone and nothing is pending.
  const spent = new Set(coins.map((c) => c.coin.nonce));
  const expected = toSelf ? have : have - amount;
  const after = await Rx.firstValueFrom(
    b.wallet.state().pipe(
      Rx.timeout({ each: 10 * 60_000, with: () => Rx.throwError(() => new Error('No confirmation within 10 minutes')) }),
      Rx.filter(
        (s) =>
          s.shielded.pendingCoins.length === 0 &&
          (s.shielded.balances[wnightColor] ?? 0n) === expected &&
          s.shielded.availableCoins.some((c) => c.coin.type === wnightColor && !spent.has(c.coin.nonce)),
      ),
    ),
  );
  const left = after.shielded.availableCoins.filter((c) => c.coin.type === wnightColor);
  logger.info(`Accepted on chain. Wallet B now holds ${left.length} wNIGHT coin(s): ${left.map((c) => formatNight(c.coin.value)).join(', ')}`);
  await logBalances('wallet B', b, wnightColor);
});

// The WASM prover's key download leaves an idle HTTP/2 connection whose later timeout is thrown as an unhandled error
// (seen on Node 26 after a successful run). Everything is done and saved here, so exit instead of waiting for it.
process.exit(process.exitCode ?? 0);
