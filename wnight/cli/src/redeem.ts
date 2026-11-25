// Wallet B burns wNIGHT and receives the same amount of tNIGHT at its own
// unshielded address.
//   npm run redeem -- 100         (amount in tNIGHT; default 100)
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { encodeUserAddress } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { CompiledWnight, type Contract } from '../../contract/src/index.js';
import { freshCoin } from '../../contract/src/test/coins.js';
import {
  NIGHT_RAW, formatNight, loadDeployment, logBalances, logLedger, logger, openWallet, parseNight,
  preprodConfig, providersFor, readLedger, runScript,
} from './wallets.js';

await runScript(async (opened) => {
  const amount = parseNight(process.argv[2] ?? '100');
  const config = preprodConfig();
  const { contractAddress, wnightColor } = loadDeployment(config);
  const b = await openWallet('B', config);
  opened.push(b);
  const providers = providersFor(b, config);

  const state = await b.wallet.waitForSyncedState();
  const have = state.shielded.balances[wnightColor] ?? 0n;
  if (have < amount) throw new Error(`Wallet B holds ${formatNight(have)} wNIGHT, less than ${formatNight(amount)}`);
  const nightBefore = state.unshielded.balances[NIGHT_RAW] ?? 0n;
  await logBalances('wallet B before', b, wnightColor);

  // A NEW coin with a random nonce: B's wallet pays for it from its wNIGHT
  // coins and takes change. Never pass one of the wallet's own coins here.
  const coin = freshCoin(wnightColor, amount);
  const recipient = { bytes: encodeUserAddress((await b.wallet.unshielded.getAddress()).hexString) };

  logger.info(`Redeeming ${formatNight(amount)} wNIGHT -> tNIGHT to ${String(b.unshieldedKeystore.getBech32Address())}...`);
  const tx = await submitCallTx<Contract<undefined>, 'redeem'>(providers, {
    compiledContract: CompiledWnight,
    contractAddress,
    circuitId: 'redeem',
    args: [coin, recipient],
  });
  logger.info(`redeem tx ${tx.public.txId}`);

  // tNIGHT in minus the DUST-paid fee (fees are DUST, so NIGHT should rise by exactly `amount`).
  const deadline = Date.now() + 300_000;
  for (;;) {
    const night = (await b.wallet.waitForSyncedState()).unshielded.balances[NIGHT_RAW] ?? 0n;
    if (night >= nightBefore + amount) break;
    if (Date.now() > deadline) throw new Error('tNIGHT payout not visible after 300s');
    await new Promise((r) => setTimeout(r, 3_000));
  }
  await logBalances('wallet B after', b, wnightColor);
  logLedger(await readLedger(providers, contractAddress));
});
