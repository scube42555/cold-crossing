// Sponsor wallet helpers (hot machine). Wallet SDK 2.x: wallets and the facade start from seeds, and the transaction
// methods take no secret keys. Shapes follow the wallet-sdk-facade 5.0.0 migration guide ("Migrating from 4.x").
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  WalletFacade,
  ShieldedWallet,
  DustWallet,
  UnshieldedWallet,
  PublicKey,
  ProtocolVersion,
} from '@midnightntwrk/wallet-sdk';
import { Option } from 'effect';
import { NETWORK, assumeLedger9, hotEndpoints, walletConfig } from './config.js';
import { LEDGER9_PROTOCOL_VERSION } from './snapshot.js';
import { type WalletKeys } from './keys.js';
import { findDustForkStart } from './dustfork.js';
import { progressLine, saveIntervalMs, syncLogIntervalMs } from './syncprogress.js';
import { elapsed } from './timefmt.js';

export type SavedWalletState = { shielded: string; unshielded: string; dust: string };

/** What finalizeRecipe returns. Taken from the SDK so it does not depend on a type name. */
export type FinalizedTx = Awaited<ReturnType<WalletFacade['finalizeRecipe']>>;

export const walletStateFile = (keys: WalletKeys): string =>
  `wallet-state-${keys.unshieldedKeystore.getBech32Address()}.json`;

export const loadWalletState = async (file: string): Promise<SavedWalletState | undefined> =>
  existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as SavedWalletState) : undefined;

export const saveWalletState = async (wallet: WalletFacade, file: string): Promise<void> => {
  const snapshot: SavedWalletState = {
    shielded: await wallet.shielded.serializeState(),
    unshielded: await wallet.unshielded.serializeState(),
    dust: await wallet.dust.serializeState(),
  };
  await writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};

/** The facade's protocol phase as text (it holds bigints, which JSON cannot print). */
export const describePhase = (protocol: unknown): string =>
  JSON.stringify(protocol, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** True once the wallets agree and are acting at ledger 9 or later. */
export const onLedger9 = (protocol: { _tag: string; version?: bigint }): boolean =>
  protocol._tag === 'Settled' && (protocol.version ?? 0n) >= LEDGER9_PROTOCOL_VERSION;

/**
 * Start the sponsor wallet from its seeds, resuming from a snapshot when one is passed.
 *
 * No chain-version probe for the shielded and DUST wallets. The sponsor syncs from the start of the chain, and a wallet told "the chain is on
 * ledger 9" begins on the ledger 9 decoder and cannot read the ledger 8 history ("Could not deserialize ledger event", repeated). They start on
 * ledger 8, read the history, and cross at the upgrade on their own. The unshielded wallet's events are plain JSON, so it can take the probe.
 * Verified (11 Nov 2026): shielded and DUST wallets crossed to ledger 9 on their own (Protocol phase: Settled 2000000).
 * Verified (11 Nov 2026): restore() accepts a snapshot written by this SDK version.
 * The lifecycle store (transactionLifecycleService.serializeState) is not saved: a fresh one per run is enough here.
 *
 * A FRESH DUST wallet starts at the ledger 9 fork instead (src/dustfork.ts, from the wnight project): the fork emptied all
 * DUST state and re-emitted live DUST as ledger 9 events, so the ledger 8 DUST history, the slowest part of a first sync,
 * holds nothing it needs. A restored wallet resumes from its saved cursor and is not affected. DUST_FORK_SEARCH=off: as before.
 */
export const buildWallet = async (keys: WalletKeys, saved?: SavedWalletState): Promise<WalletFacade> => {
  const { seeds, unshieldedKeystore } = keys;
  const endpoints = hotEndpoints();
  const forkStart = saved || NETWORK === 'undeployed' ? undefined : await findDustForkStart(NETWORK, endpoints.indexerHttpUrl, endpoints.indexerWsUrl);
  const dustStart = forkStart
    ? { dustTimelineStartProbe: async () => Option.some({ cursor: forkStart.cursor, version: ProtocolVersion.ProtocolVersion(forkStart.version) }) }
    : {};

  const wallet = await WalletFacade.init({
    configuration: walletConfig(endpoints, { assumeLedger9: false }),
    shielded: (cfg) => (saved ? ShieldedWallet(cfg).restore(saved.shielded) : ShieldedWallet(cfg).startWithSeed(seeds.shielded)),
    unshielded: (cfg) =>
      saved
        ? UnshieldedWallet(cfg).restore(saved.unshielded)
        : UnshieldedWallet({ ...cfg, chainVersionProbe: assumeLedger9 }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) => (saved ? DustWallet(cfg).restore(saved.dust) : DustWallet({ ...cfg, ...dustStart }).startWithSeed(seeds.dust)),
  });
  await wallet.start(seeds); // 4.x: wallet.start(shieldedSecretKeys, dustSecretKey)
  return wallet;
};

type SyncedState = Awaited<ReturnType<WalletFacade['waitForSyncedState']>>;

/**
 * Wait for a full sync, printing progress like the wnight project: a line whenever a part (shielded, unshielded, DUST)
 * finishes, and otherwise every MIDNIGHT_SYNC_LOG_INTERVAL_MS (default 15 s). What is synced so far is saved to `file`
 * every MIDNIGHT_WALLET_SAVE_INTERVAL_MS (default 5 minutes), on Ctrl-C and if the sync fails, so a long first sync that is
 * interrupted resumes from the last save instead of from the start. The synced state is saved at the end.
 */
export const syncAndSave = async (wallet: WalletFacade, file: string): Promise<SyncedState> => {
  const started = Date.now();
  const interval = syncLogIntervalMs();
  let updates = 0;
  let lastKey = '';
  let lastAt = 0;
  let lastLine = 'Sync: waiting for the first update from the indexer';
  const print = (line: string) => {
    console.log(line);
    lastAt = Date.now();
  };
  const sub = wallet.state().subscribe((s) => {
    updates++;
    const { line, key } = progressLine(
      { shielded: s.shielded.progress, unshielded: s.unshielded.progress, dust: s.dust.progress },
      updates,
      Math.round((Date.now() - started) / 1000),
    );
    lastLine = line;
    if (key !== lastKey || Date.now() - lastAt >= interval) {
      lastKey = key;
      print(line);
    }
  });
  // A quiet indexer sends nothing for minutes: still show that the run is alive.
  const heartbeat = setInterval(() => {
    if (Date.now() - lastAt >= interval) print(`${lastLine.replace(/^Sync \(\d+ s\)/, `Sync (${Math.round((Date.now() - started) / 1000)} s)`)}, no new update`);
  }, interval);
  let saving: Promise<void> | undefined;
  const saveProgress = (): Promise<void> =>
    (saving ??= saveWalletState(wallet, file)
      .then(() => console.log(`Saved sync progress to ${file}.`))
      .catch((err: unknown) => console.warn(`Could not save sync progress: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        saving = undefined;
      }));
  const saver = setInterval(() => void saveProgress(), saveIntervalMs());
  // Ctrl-C in a terminal, SIGTERM from the hot page's Stop: save first, then exit.
  const onSignal = (signal: NodeJS.Signals) => {
    console.warn('Interrupted: saving sync progress before exiting (Ctrl-C again to quit without saving)...');
    process.once('SIGINT', () => process.exit(130));
    void saveProgress().finally(() => process.exit(signal === 'SIGTERM' ? 143 : 130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let synced: SyncedState;
  try {
    synced = await wallet.waitForSyncedState();
  } catch (err) {
    await saveProgress();
    throw err;
  } finally {
    sub.unsubscribe();
    clearInterval(heartbeat);
    clearInterval(saver);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  await saving;
  await saveWalletState(wallet, file);
  console.log(`Synced in ${elapsed(Date.now() - started)} (${updates} updates); saved the synced wallet state to ${file}.`);
  return synced;
};

/** Submit a finalized transaction, trying again if the connection to the node drops. */
export const submitWithRetry = async (wallet: WalletFacade, tx: FinalizedTx, attempts = 3): Promise<string> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await wallet.submitTransaction(tx);
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(`Submission attempt ${attempt} failed, trying again`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
};
