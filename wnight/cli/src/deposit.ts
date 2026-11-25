// Wallet A locks tNIGHT in wnight and receives the same amount of wNIGHT.
//   npm run deposit -- 100        (amount in tNIGHT; default 100)
import { randomBytes } from 'node:crypto';
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledWnight, type Contract } from '../../contract/src/index.js';
import { waitForShieldedBalance } from '../../contract/src/test/coins.js';
import {
  formatNight, loadDeployment, logBalances, logLedger, logger, openWallet, parseNight,
  preprodConfig, providersFor, readLedger, runScript,
} from './wallets.js';

await runScript(async (opened) => {
  const amount = parseNight(process.argv[2] ?? '100');
  if (amount <= 0n || amount >= 2n ** 64n) throw new Error('Amount must be > 0 and fit in Uint<64> STAR');
  const config = preprodConfig();
  const { contractAddress, wnightColor } = loadDeployment(config);
  const a = await openWallet('A', config);
  opened.push(a);
  const providers = providersFor(a, config);

  const before = (await a.wallet.waitForSyncedState()).shielded.balances[wnightColor] ?? 0n;
  await logBalances('wallet A before', a, wnightColor);

  logger.info(`Depositing ${formatNight(amount)} tNIGHT...`);
  // The nonce must be fresh and random. The contract also mixes in its deposit
  // counter, so even a reused nonce cannot produce a duplicate coin.
  const tx = await submitCallTx<Contract<undefined>, 'deposit'>(providers, {
    compiledContract: CompiledWnight,
    contractAddress,
    circuitId: 'deposit',
    args: [amount, new Uint8Array(randomBytes(32))],
  });
  logger.info(`deposit tx ${tx.public.txId}`);

  await waitForShieldedBalance(a, wnightColor, before + amount, { logger });
  await logBalances('wallet A after', a, wnightColor);
  logLedger(await readLedger(providers, contractAddress));
});
