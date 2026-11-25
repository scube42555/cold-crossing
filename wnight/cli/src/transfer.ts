// Wallet A sends wNIGHT to wallet B with an ordinary shielded transfer.
// The contract is not involved.
//   npm run transfer -- 100       (amount in tNIGHT; default 100)
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import { waitForShieldedBalance } from '../../contract/src/test/coins.js';
import {
  formatNight, loadDeployment, logBalances, logger, openWallet, parseNight, preprodConfig, runScript,
} from './wallets.js';

await runScript(async (opened) => {
  const amount = parseNight(process.argv[2] ?? '100');
  const config = preprodConfig();
  const { wnightColor } = loadDeployment(config);
  const a = await openWallet('A', config);
  opened.push(a);
  const b = await openWallet('B', config);
  opened.push(b);

  const have = (await a.wallet.waitForSyncedState()).shielded.balances[wnightColor] ?? 0n;
  if (have < amount) throw new Error(`Wallet A holds ${formatNight(have)} wNIGHT, less than ${formatNight(amount)}`);
  const bBefore = (await b.wallet.waitForSyncedState()).shielded.balances[wnightColor] ?? 0n;

  logger.info(`Sending ${formatNight(amount)} wNIGHT A -> B (shielded)...`);
  const recipe = await a.wallet.transferTransaction(
    [{ type: 'shielded', outputs: [{ type: wnightColor, receiverAddress: b.getShieldedAddress(), amount }] }],
    { ttl: ttlOneHour(), payFees: true },
  );
  const signed = await a.wallet.signRecipe(recipe, (payload) => a.unshieldedKeystore.signDataAsync(payload));
  const txId = await a.wallet.submitTransaction(await a.wallet.finalizeRecipe(signed));
  logger.info(`transfer tx ${txId}`);

  await waitForShieldedBalance(b, wnightColor, bBefore + amount, { logger });
  await logBalances('wallet A', a, wnightColor);
  await logBalances('wallet B', b, wnightColor);
});
