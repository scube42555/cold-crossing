// Shared setup for the CLI scripts: Preprod-only guard, wallets A and B from
// .env, DUST registration, providers, and the saved deployment.
//
// Run directly (`npm run wallets`) to print both wallets' addresses and
// balances, registering their tNIGHT for DUST if needed.

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import pino from 'pino';
import { type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { getConfig, type NetworkConfig } from './config.js';
import { MidnightWalletProvider, syncWallet, waitForNightThenDust, type WalletSecret } from './wallet.js';
import { buildProviders, ledgerState, type WnightProviders } from './providers.js';
import { ledger, zkConfigPath, type Ledger } from '../../contract/src/index.js';

// The indexer client needs a global WebSocket under Node.
(globalThis as any).WebSocket = WebSocket;

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

/** 1 NIGHT = 10^6 STAR. Contract amounts are in STAR. */
export const STAR_PER_NIGHT = 1_000_000n;
export const NIGHT_RAW = unshieldedToken().raw;

/** Parse a decimal tNIGHT amount ("100", "0.5") into STAR. */
export function parseNight(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) throw new Error(`Not a tNIGHT amount: '${s}' (up to 6 decimals)`);
  return BigInt(m[1]!) * STAR_PER_NIGHT + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function formatNight(star: bigint): string {
  return `${star / STAR_PER_NIGHT}.${(star % STAR_PER_NIGHT).toString().padStart(6, '0')}`;
}

/**
 * The network config, refusing anything but Preprod. This project must never
 * submit to Mainnet (real funds) and is only set up for Preprod.
 */
export function preprodConfig(): NetworkConfig {
  const network = process.env['MIDNIGHT_NETWORK'];
  if (network !== 'preprod') {
    throw new Error(`MIDNIGHT_NETWORK must be 'preprod' (got '${network ?? ''}'). This project targets Preprod only.`);
  }
  const config = getConfig();
  if (config.networkId !== 'preprod') throw new Error(`Refusing network id '${config.networkId}'.`);
  return config;
}

export function envConfig(config: NetworkConfig): EnvironmentConfiguration {
  return { walletNetworkId: config.networkId, ...config };
}

export type WalletLabel = 'A' | 'B';

/** Wallet secret from MNEMONIC_<label> (e.g. a Lace recovery phrase) or SEED_<label> (hex). */
function secretFor(label: WalletLabel): WalletSecret {
  const mnemonic = process.env[`MNEMONIC_${label}`]?.trim().replace(/\s+/g, ' ');
  const seed = process.env[`SEED_${label}`]?.trim();
  if (mnemonic && seed) throw new Error(`Set only one of MNEMONIC_${label} or SEED_${label}.`);
  if (mnemonic) {
    const words = mnemonic.split(' ').length;
    if (![12, 15, 18, 21, 24].includes(words)) throw new Error(`MNEMONIC_${label} has ${words} words; expected 12-24.`);
    return { kind: 'mnemonic', value: mnemonic };
  }
  if (!seed) throw new Error(`Set MNEMONIC_${label} or SEED_${label}. Copy .env.example to .env and fill it in.`);
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) throw new Error(`SEED_${label} must be 64 hex characters (32 bytes), no 0x.`);
  return { kind: 'seed', value: seed };
}

/**
 * Build, start and sync wallet A or B, then block until it has tNIGHT and
 * spendable DUST. An unfunded wallet prints its address and the faucet URL and
 * waits; its tNIGHT is registered for DUST generation automatically.
 */
export async function openWallet(label: WalletLabel, config = preprodConfig()): Promise<MidnightWalletProvider> {
  const env = envConfig(config);
  const w = await MidnightWalletProvider.build(logger, env, secretFor(label));
  await w.start();
  // A fresh Preprod wallet's first sync takes several minutes.
  await syncWallet(logger, w.wallet, 30 * 60_000);
  await waitForNightThenDust(logger, w.wallet, w.unshieldedKeystore, env, config.faucet, { label: `wallet ${label}` });
  return w;
}

export function providersFor(w: MidnightWalletProvider, config: NetworkConfig): WnightProviders {
  return buildProviders(w, zkConfigPath, config);
}

// ---------------------------------------------------------------------------
// The deployment this project uses (written by deploy.ts).

export type Deployment = { networkId: string; contractAddress: string; wnightColor: string; deployedAt: string };

const DEPLOYMENT_FILE = fileURLToPath(new URL('../../.deployment.json', import.meta.url));

export function saveDeployment(d: Deployment): void {
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, null, 2) + '\n');
  logger.info(`Saved deployment to ${DEPLOYMENT_FILE}`);
}

export function loadDeployment(config: NetworkConfig): Deployment {
  if (!existsSync(DEPLOYMENT_FILE)) throw new Error('No .deployment.json; run `npm run deploy` first.');
  const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) as Deployment;
  if (d.networkId !== config.networkId) {
    throw new Error(`.deployment.json is for '${d.networkId}', not '${config.networkId}'.`);
  }
  return d;
}

export async function readLedger(providers: WnightProviders, contractAddress: string): Promise<Ledger> {
  return ledger(ledgerState(await providers.publicDataProvider.queryContractState(contractAddress)));
}

export async function logBalances(label: string, w: MidnightWalletProvider, wnightColor?: string): Promise<void> {
  const s = await w.wallet.waitForSyncedState();
  const night = s.unshielded.balances[NIGHT_RAW] ?? 0n;
  const wn = wnightColor ? (s.shielded.balances[wnightColor] ?? 0n) : undefined;
  logger.info(
    `${label}: tNIGHT ${formatNight(night)}` +
      (wn !== undefined ? `, wNIGHT ${formatNight(wn)}` : '') +
      `, DUST ${s.dust.balance(new Date())} specks`,
  );
}

export function logLedger(l: Ledger): void {
  logger.info(
    `contract: totalLocked ${formatNight(l.totalLocked)}, totalMinted ${formatNight(l.totalMinted)}, ` +
      `deposits ${l.deposits}, redeemed coins ${l.redeemed.size()}`,
  );
  if (l.totalLocked !== l.totalMinted) logger.error('INVARIANT BROKEN: totalLocked != totalMinted');
}

/** Run `main` as a script: always stop the wallets, set the exit code. */
export async function runScript(main: (opened: MidnightWalletProvider[]) => Promise<void>): Promise<void> {
  const opened: MidnightWalletProvider[] = [];
  try {
    await main(opened);
  } catch (err) {
    logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  } finally {
    for (const w of opened) await w.stop().catch(() => undefined);
  }
}

// `npm run wallets`: show both wallets, funding and registering DUST as needed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runScript(async (opened) => {
    const config = preprodConfig();
    const color = existsSync(DEPLOYMENT_FILE) ? loadDeployment(config).wnightColor : undefined;
    for (const label of ['A', 'B'] as const) {
      const w = await openWallet(label, config);
      opened.push(w);
      logger.info(`wallet ${label} unshielded: ${String(w.unshieldedKeystore.getBech32Address())}`);
      await logBalances(`wallet ${label}`, w, color);
    }
  });
}
