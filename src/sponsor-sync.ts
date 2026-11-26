// Run on the HOT machine, EARLY: syncs the sponsor wallet and saves its state, and does nothing else. sponsor-submit, the
// last step of every transfer, needs the sponsor synced; a first sync takes hours, and a shielded tx.hex expires about
// 50 minutes after its feed. Run this at the first step (another terminal is fine) so the last step only catches up.
//
// Usage: node dist/sponsor-sync.js      (SPONSOR_MNEMONIC or SPONSOR_SEED set, as for sponsor-submit; run in the same folder)
// Ctrl-C saves what is synced so far; the next run (this or sponsor-submit) resumes from it.
import { NETWORK, NETWORK_ID } from './config.js';
import { checkColdPublicNetwork } from './crosscheck.js';
import { statSync } from 'node:fs';
import { DustAddress } from '@midnightntwrk/wallet-sdk';
import { beep } from './beep.js';
import { deriveAndWipe, readSeed } from './keys.js';
import { formatDust, NIGHT } from './txinfo.js';
import { elapsed, localStamp } from './timefmt.js';
import { buildWallet, describePhase, loadWalletState, onLedger9, syncAndSave, walletStateFile } from './wallet.js';

const startedAt = new Date();
console.log(`Started:  ${localStamp(startedAt)}`);
checkColdPublicNetwork(NETWORK);
console.log(`Network:  ${NETWORK}`);

const keys = deriveAndWipe(readSeed('SPONSOR'));
console.log(`Sponsor:  ${keys.unshieldedKeystore.getBech32Address().asString()}`);
const stateFile = walletStateFile(keys);
const saved = await loadWalletState(stateFile);
console.log(
  saved
    ? `Resuming from ${stateFile} (last saved ${localStamp(statSync(stateFile).mtime)}).`
    : `No saved state (${stateFile}): first sync. It can take hours; progress is saved every few minutes.`,
);
const wallet = await buildWallet(keys, saved);
const state = await syncAndSave(wallet, stateFile);
if (!saved) beep(3); // the long first sync is done

const dust = state.dust.balance(new Date());
console.log(`Protocol phase:       ${describePhase(state.protocol)}`);
console.log(`Sponsor NIGHT (STAR): ${state.unshielded.balances[NIGHT] ?? 0n}`);
console.log(`Sponsor DUST address: ${String(DustAddress.encodePublicKey(NETWORK_ID, state.dust.publicKey))}`);
console.log(`Sponsor DUST balance: ${formatDust(dust)} DUST`);
if (!onLedger9(state.protocol)) console.warn('The wallets are not settled on ledger 9 yet: sponsor-submit would build a ledger 8 transaction.');
if (dust === 0n) console.warn('No DUST: sponsor-submit cannot pay a fee. Fund the sponsor and run hot:sponsor-register.');
else console.log('Ready: sponsor-submit in this folder resumes from this state and only catches up.');
await wallet.stop();
console.log(`Finished: ${localStamp(new Date())}  (total ${elapsed(Date.now() - startedAt.getTime())})`);
process.exit(0);
