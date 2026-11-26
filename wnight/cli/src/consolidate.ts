// Wallet A sends tNIGHT to itself, merging small UTXOs into one coin.
//
//   npm run consolidate -- [amount]     (amount in tNIGHT; default 100)
//
// Why: the wallet pays an unshielded amount from its smallest UTXOs first. A
// wallet holding many small faucet coins then spends all of them in one
// transaction, and a contract call with that many inputs can exceed the
// ledger's time-to-dismiss limit; the node rejects it with
// "Invalid Transaction: Custom error: 231". After this, A holds one coin of
// exactly `amount` (plus change), and a deposit of that amount spends just it.
import * as Rx from 'rxjs';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import { NIGHT_RAW, formatNight, logger, openWallet, warnIfOtherWalletUnsynced, parseNight, preprodConfig, runScript } from './wallets.js';

const values = (coins: readonly { utxo: { value: bigint } }[]) =>
  coins.map((c) => c.utxo.value).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

await runScript(async (opened) => {
  const amount = parseNight(process.argv[2] ?? '100');
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  const config = preprodConfig();
  warnIfOtherWalletUnsynced('A', config);
  const a = await openWallet('A', config);
  opened.push(a);

  const before = await a.wallet.waitForSyncedState();
  const coins = before.unshielded.availableCoins;
  logger.info(`wallet A: ${coins.length} tNIGHT UTXOs: ${values(coins).map(formatNight).join(', ')}`);
  const night = before.unshielded.balances[NIGHT_RAW] ?? 0n;
  if (night < amount) throw new Error(`Wallet A holds ${formatNight(night)} tNIGHT, less than ${formatNight(amount)}`);

  const self = await a.wallet.unshielded.getAddress();
  logger.info(`Sending ${formatNight(amount)} tNIGHT from A to itself...`);
  const recipe = await a.wallet.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: NIGHT_RAW, receiverAddress: self, amount }] }],
    { ttl: ttlOneHour(), payFees: true },
  );
  const signed = await a.wallet.signRecipe(recipe, (payload) => a.unshieldedKeystore.signDataAsync(payload));
  const txId = await a.wallet.submitTransaction(await a.wallet.finalizeRecipe(signed));
  logger.info(`consolidate tx ${txId}; waiting for it on chain...`);

  // Done when the spent coins are gone and the balance is back (a self-transfer
  // moves no tNIGHT; the fee is DUST).
  const spent = new Set(coins.map((c) => `${c.utxo.intentHash}:${c.utxo.outputNo}`));
  const after = await Rx.firstValueFrom(
    a.wallet.state().pipe(
      Rx.timeout({ each: 10 * 60_000, with: () => Rx.throwError(() => new Error('No confirmation within 10 minutes')) }),
      Rx.filter((s) => {
        const now = s.unshielded.availableCoins;
        const gone = coins.length - now.filter((c) => spent.has(`${c.utxo.intentHash}:${c.utxo.outputNo}`)).length;
        return gone > 0 && (s.unshielded.balances[NIGHT_RAW] ?? 0n) === night;
      }),
    ),
  );
  const left = after.unshielded.availableCoins;
  logger.info(`wallet A: ${left.length} tNIGHT UTXOs: ${values(left).map(formatNight).join(', ')}`);
});
