// Wallet A sends wNIGHT to any shielded address with an ordinary shielded
// transfer. The contract is not involved, and the recipient's keys are not
// needed: only their shielded address.
//
//   npm run transfer -- <mn_shield-addr_preprod1...> [amount]   (amount in tNIGHT; default 100)
//
// Check the recipient's balance with their own wallet (for wallet B,
// `npm run wallets`). From the sender's side, a shielded transfer is
// confirmed once A's wNIGHT balance drops by the amount sent.
import { MidnightBech32m, ShieldedAddress } from '@midnightntwrk/wallet-sdk';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import { waitForShieldedBalance } from '../../contract/src/test/coins.js';
import {
  formatNight, loadDeployment, logBalances, logger, openWallet, parseNight, preprodConfig, runScript,
} from './wallets.js';

const USAGE = 'Usage: npm run transfer -- <mn_shield-addr_preprod1...> [amount in tNIGHT, default 100]';

/** Decode a Bech32m shielded address, refusing any other address kind or network. */
function parseShieldedAddress(s: string | undefined, networkId: string): ShieldedAddress {
  if (!s) throw new Error(`Missing recipient shielded address.\n${USAGE}`);
  try {
    return ShieldedAddress.codec.decode(networkId, MidnightBech32m.parse(s.trim()));
  } catch (err) {
    throw new Error(
      `'${s}' is not a ${networkId} shielded address (expected mn_shield-addr_${networkId}1...): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

await runScript(async (opened) => {
  const config = preprodConfig();
  const receiverAddress = parseShieldedAddress(process.argv[2], config.networkId);
  const amount = parseNight(process.argv[3] ?? '100');
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  const { wnightColor } = loadDeployment(config);

  const a = await openWallet('A', config);
  opened.push(a);

  const recipientStr = MidnightBech32m.encode(config.networkId, receiverAddress).asString();
  const ownStr = MidnightBech32m.encode(config.networkId, a.getShieldedAddress()).asString();
  if (recipientStr === ownStr) throw new Error('Recipient is wallet A itself.');

  const have = (await a.wallet.waitForSyncedState()).shielded.balances[wnightColor] ?? 0n;
  if (have < amount) throw new Error(`Wallet A holds ${formatNight(have)} wNIGHT, less than ${formatNight(amount)}`);

  logger.info(`Sending ${formatNight(amount)} wNIGHT from A to ${recipientStr} (shielded)...`);
  const recipe = await a.wallet.transferTransaction(
    [{ type: 'shielded', outputs: [{ type: wnightColor, receiverAddress, amount }] }],
    { ttl: ttlOneHour(), payFees: true },
  );
  const signed = await a.wallet.signRecipe(recipe, (payload) => a.unshieldedKeystore.signDataAsync(payload));
  const txId = await a.wallet.submitTransaction(await a.wallet.finalizeRecipe(signed));
  logger.info(`transfer tx ${txId}`);

  // Change comes back to A under a new coin once the transaction is on chain,
  // so A's balance settles at exactly `have - amount`.
  await waitForShieldedBalance(a, wnightColor, have - amount, { logger });
  await logBalances('wallet A', a, wnightColor);
  logger.info('Sent. The recipient sees it after their wallet syncs.');
});
