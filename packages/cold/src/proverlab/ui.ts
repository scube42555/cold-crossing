// The prover lab page's controller (dist/prover-lab.html, built by scripts/build-prover-lab.mjs). EXPERIMENT: it proves one
// shielded output for a random throwaway key, offline, and reports how long it took. It never runs under Node.
// File names and contents from outside are shown with textContent only.
import { sha256 } from '@noble/hashes/sha2.js';
import { loadLedger } from 'virtual:ledger-v9';
import { loadZkir } from 'virtual:zkir-v2';
import { toHex } from '../hex.js';
import { OUTPUT_FILES, type Pins, circuitK, displayName, identify, proveOneOutput } from './core.js';

declare const __PINS__: Pins;
declare const __PINS_SOURCE__: string;
const pins = __PINS__;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const files = new Map<string, Uint8Array>();

const log = (line: string) => {
  const el = $('log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
  el.scrollTop = el.scrollHeight;
};
const showError = (msg: string) => {
  $('error').textContent = msg;
  $('error').hidden = msg === '';
};

/** The files still missing: the three output files, then the parameters for the circuit's k once its IR is loaded. */
const needed = (Z: Awaited<ReturnType<typeof loadZkir>>['zkir'] | undefined): string[] => {
  const names: string[] = [...OUTPUT_FILES];
  const ir = files.get('zswap/output.bzkir');
  if (ir && Z) names.push(`params/${circuitK(Z, ir)}`);
  else names.push('params/?');
  return names;
};

const render = (Z?: Awaited<ReturnType<typeof loadZkir>>['zkir']) => {
  const list = $('files');
  list.replaceChildren();
  let missing = 0;
  for (const name of needed(Z)) {
    const li = document.createElement('li');
    const have = files.get(name);
    const label = name === 'params/?' ? 'bls_midnight_2p<k> (k shows once output.bzkir is loaded)' : displayName(name, pins.generation);
    li.textContent = have ? `✓ ${label}  (${have.length.toLocaleString()} bytes, SHA-256 matches the SDK pin)` : `✗ ${label}`;
    li.className = have ? 'ok' : 'missing';
    if (!have) missing++;
    list.append(li);
  }
  ($('run') as HTMLButtonElement).disabled = missing > 0;
};

const main = async () => {
  $('pins').textContent = __PINS_SOURCE__;
  $('online').textContent = navigator.onLine ? 'The browser reports a network connection. For a real test, disconnect it.' : 'The browser reports no network connection.';
  log('Loading the ledger and prover WebAssembly modules (inlined in this page)...');
  const L = await loadLedger();
  const { zkir: Z, memory } = await loadZkir();
  log('Modules ready.');
  render(Z);

  const take = async (list: FileList | null) => {
    showError('');
    for (const f of Array.from(list ?? [])) {
      if (f.size > 64 * 2 ** 20) {
        log(`Skipped ${f.name}: larger than 64 MiB, so not a key file of this lab.`);
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const digest = toHex(sha256(bytes));
      const name = identify(digest, pins);
      if (!name) {
        log(`Rejected ${f.name}: SHA-256 ${digest.slice(0, 16)}... matches no file the SDK pins.`);
        continue;
      }
      files.set(name, bytes);
      log(`Accepted ${f.name} as ${displayName(name, pins.generation)}.`);
    }
    render(Z);
  };
  const input = $<HTMLInputElement>('pick');
  input.addEventListener('change', () => void take(input.files).catch((e) => showError(String(e))));
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    void take(e.dataTransfer?.files ?? null).catch((err) => showError(String(err)));
  });

  $('run').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('run');
    button.disabled = true;
    showError('');
    $('result').hidden = true;
    log('Proving one shielded output. The page stops responding until it finishes (about a minute on a laptop).');
    // Let the browser paint the message before the prover takes the thread.
    await new Promise((r) => setTimeout(r, 50));
    try {
      const r = await proveOneOutput(L, Z, files, pins, crypto.getRandomValues(new Uint8Array(32)), () => performance.now());
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const lines = [
        `Proof made in ${(r.proveMs / 1000).toFixed(2)} s and accepted by the ledger's verifier in ${r.verifyMs.toFixed(0)} ms.`,
        `Transaction size: ${r.txBytes.toLocaleString()} bytes.`,
        `Prover memory (WebAssembly): ${(memory().buffer.byteLength / 2 ** 20).toFixed(0)} MiB` +
          (mem ? `; JavaScript heap ${(mem.usedJSHeapSize / 2 ** 20).toFixed(0)} MiB.` : '.'),
        `The prover asked for: ${r.requests.join(', ')}.`,
        `Browser: ${navigator.userAgent}; ${navigator.hardwareConcurrency ?? '?'} logical CPUs; online: ${navigator.onLine}.`,
      ];
      $('result-text').textContent = lines.join('\n');
      $('result').hidden = false;
      $('result').dataset['verified'] = 'yes';
      log('Done.');
    } catch (e) {
      showError(`Proving failed: ${e instanceof Error ? e.message : String(e)}`);
      log('Failed.');
    } finally {
      button.disabled = false;
      render(Z);
    }
  });
};

main().catch((e) => showError(`The page could not start: ${e instanceof Error ? e.message : String(e)}`));
