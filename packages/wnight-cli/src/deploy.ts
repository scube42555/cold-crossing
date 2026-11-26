// Deploy wnight to Preprod from wallet A and save its address and wNIGHT color.
//   npm run deploy
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledWnight, pureCircuits } from '../../contract/src/index.js';
import { tokenColor } from '../../contract/src/test/coins.js';
import { logLedger, logger, openWallet, warnIfOtherWalletUnsynced, preprodConfig, providersFor, readLedger, runScript, saveDeployment } from './wallets.js';

await runScript(async (opened) => {
  const config = preprodConfig();
  warnIfOtherWalletUnsynced('A', config);
  const a = await openWallet('A', config);
  opened.push(a);
  const providers = providersFor(a, config);

  logger.info('Deploying wnight (proving takes a while)...');
  const deployed = await deployContract(providers, { compiledContract: CompiledWnight });
  const contractAddress = deployed.deployTxData.public.contractAddress;
  const color = tokenColor(pureCircuits.wnightDomain(), contractAddress);
  logger.info(`Deployed at ${contractAddress}; wNIGHT color ${color.hex}`);

  saveDeployment({ networkId: config.networkId, contractAddress, wnightColor: color.hex, deployedAt: new Date().toISOString() });
  logLedger(await readLedger(providers, contractAddress));
});
