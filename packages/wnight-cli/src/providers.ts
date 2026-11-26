// Midnight.js 5 provider bundle, adapted from midnight-examples
// (examples/private-tip-jar/src/providers.ts, Apache-2.0).
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type MidnightProviders,
  type ContractStateRead,
} from '@midnight-ntwrk/midnight-js-types';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { type MidnightWalletProvider } from './wallet.js';
import { type NetworkConfig } from './config.js';
import { type ImpureCircuits } from '../../contract/src/index.js';

export type WnightCircuits = keyof ImpureCircuits<unknown>;
export type WnightProviders = MidnightProviders<any>;

const TX_TTL_SECONDS = Number(process.env['MIDNIGHT_TX_TTL_SECONDS'] ?? 3600);

export function buildProviders(
  wallet: MidnightWalletProvider,
  zkConfigPath: string,
  config: NetworkConfig,
): WnightProviders {
  const zkConfigProvider = new NodeZkConfigProvider<WnightCircuits>(zkConfigPath);
  return {
    // wnight has no private state, but Midnight.js still wants a store.
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `wnight-${wallet.getCoinPublicKey().slice(0, 16)}`,
      privateStoragePasswordProvider: () => 'Wnight-Preprod-Store-Pw!',
      accountId: wallet.getCoinPublicKey(),
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: createLedger9WalletProvider(wallet),
    midnightProvider: createLedger9MidnightProvider((tx) => wallet.submitTx(tx)),
    config: { networkId: config.networkId, ttlSeconds: TX_TTL_SECONDS },
  };
}

/** Decode a ledger 9 contract state read for the compiled `ledger()`. */
export function ledgerState(read: ContractStateRead | null) {
  if (read === null) throw new Error('contract state not found');
  if (read.contractState.era !== 'v9') throw new Error('expected a ledger 9 contract state');
  return read.contractState.deserialize({ v9: ContractState }).data;
}
