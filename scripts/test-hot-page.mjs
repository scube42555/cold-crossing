// Drives dist/hot-page.html in headless Chromium against a real tools/hot_server.py, and checks the results with the
// Node code. Run with `npm run test:hotpage` after `npm run build`. Needs Chromium (CHROMIUM) and python3.
// No wallet, no network, no secret: hot-watch and sponsor-submit are the stand-ins in tests-hot/fake-dist, which copy
// prepared files and ask sponsor-submit's question. hot-inspect is the real one, reading a real ledger 9 transaction
// built here with a random throwaway key from a made-up snapshot.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as L from '@midnightntwrk/wallet-sdk/ledger/v9';
import { buildTransfer, checkSnapshot, coldPublicJson, encodeAddress, planTransfer, wholeSeconds } from '../dist/coldpage/core.js';
import { deriveColdKeys } from '../dist/coldpage/keys.js';
import { toHex } from '../dist/hex.js';
import { decodeMqrText, encodeFrames, sha256hex } from '../dist/mqr.js';

const NIGHT = '0'.repeat(64);
const network = 'preprod';

// ---------- test data: one throwaway wallet, a snapshot before and after, and a signed transfer ----------

const own = deriveColdKeys(L, generateMnemonic(wordlist, 256), '', network);
const recipientHex = toHex(randomBytes(32));
const recipient = encodeAddress(network, recipientHex);
const coin = (value, intentHash, outputNo) => ({
  utxo: { value: value.toString(), owner: own.address, type: NIGHT, intentHash, outputNo },
  meta: { ctime: '2026-11-06T22:22:54.000Z', registeredForDustGeneration: false },
});
const snapshotOf = (coins) =>
  JSON.stringify({
    version: 'v2',
    writtenBy: 'v2',
    publicKey: { publicKey: own.publicKey, addressHex: own.addressHex, address: own.address },
    state: { availableUtxos: coins, pendingUtxos: [] },
    protocolVersion: '2001100',
    appliedId: '737342',
    networkId: network,
  });
const small = coin(80_000_000n, toHex(randomBytes(32)), 0);
const large = coin(4_998_500_000n, toHex(randomBytes(32)), 1);
const before = snapshotOf([large, small]);
const plan = planTransfer(checkSnapshot(before, { network, address: own.address }), {
  tokenType: NIGHT,
  amount: 1_000_000n,
  recipientHex,
  ownAddressHex: own.addressHex,
});
const { bytes } = await buildTransfer(L, { network, keys: own, plan, ttl: wholeSeconds(new Date(Date.now() + 90 * 60_000)) });
const txHex = toHex(bytes);
// After the transfer the small coin is gone and the change has arrived.
const after = snapshotOf([large, coin(79_000_000n, toHex(randomBytes(32)), 0)]);
const publicJson = coldPublicJson(network, own);

const work = mkdtempSync(join(tmpdir(), 'hot-page-test-'));
const beforeFile = join(work, 'prepared-before.json');
const afterFile = join(work, 'prepared-after.json');
writeFileSync(beforeFile, before);
writeFileSync(afterFile, after);
const folder = join(work, 'hot');
const profile = join(work, 'profile');

// ---------- the server ----------

const MARKER = 'marker-not-a-real-phrase-51c2';
const serverEnv = {
  ...process.env,
  MIDNIGHT_NETWORK: network,
  SPONSOR_MNEMONIC: MARKER, // the stand-in only says whether it is set
  FAKE_SNAPSHOT: beforeFile,
  FAKE_SNAPSHOT_AFTER: afterFile,
  FAKE_WATCH_MS: '300',
  HOT_TEST_REAL_DIST: resolve('dist'),
};
delete serverEnv.BLOCKFROST_PROJECT_ID;
mkdirSync(folder);
const port = 18000 + Math.floor(Math.random() * 2000);
const server = spawn('python3', ['tools/hot_server.py', '--dir', folder, '--port', String(port), '--dist', resolve('tests-hot/fake-dist')], {
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
const openUrl = await new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error(`The server did not start:\n${serverOut}`)), 15_000);
  const seen = (chunk) => {
    serverOut += chunk;
    const m = /Open:\s+(http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{32})/.exec(serverOut);
    if (m) {
      clearTimeout(timer);
      ok(m[1]);
    }
  };
  server.stdout.on('data', seen);
  server.stderr.on('data', seen);
  server.on('exit', (code) => fail(new Error(`The server stopped (exit ${code}):\n${serverOut}`)));
});
const origin = new URL(openUrl).origin;
const token = new URL(openUrl).hash.slice(1);

// ---------- a very small DevTools client (Node's built-in WebSocket; no test dependency) ----------

const chromium = spawn(
  process.env.CHROMIUM ?? 'chromium',
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--no-sandbox', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const cleanUp = () => {
  chromium.kill();
  server.kill('SIGINT');
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Chromium may still be writing; the folder is in the system's temporary directory
  }
};
process.on('exit', cleanUp);

const wsUrl = await new Promise((ok, fail) => {
  let seen = '';
  const timer = setTimeout(() => fail(new Error(`Chromium did not start:\n${seen}`)), 20_000);
  chromium.stderr.on('data', (chunk) => {
    seen += chunk;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
    if (m) {
      clearTimeout(timer);
      ok(m[1]);
    }
  });
  chromium.on('error', (e) => fail(new Error(`Could not run Chromium (${e.message}). Set CHROMIUM to its path.`)));
});
const ws = new WebSocket(wsUrl);
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = () => fail(new Error('Could not connect to Chromium.'));
});
let nextId = 0;
const waiting = new Map();
const requests = [];
const problems = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w.fail(new Error(msg.error.message));
    else w.ok(msg.result);
  } else if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
  else if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text}`);
};
const send = (method, params = {}, sessionId) =>
  new Promise((ok, fail) => {
    const id = ++nextId;
    waiting.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp('Network.enable');
await cdp('Runtime.enable');
await cdp('Log.enable');
await cdp('Page.enable');

const page = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const js = (v) => JSON.stringify(v);
const type = (id, value) =>
  page(`(() => { const e = document.getElementById(${js(id)}); e.value = ${js(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const click = (id) => page(`document.getElementById(${js(id)}).click()`);
const text = (id) => page(`document.getElementById(${js(id)}).textContent`);
const visible = (id) => page(`!document.getElementById(${js(id)}).hidden`);
const locked = (id) => page(`document.getElementById(${js(id)}).classList.contains('locked')`);
const disabled = (id) => page(`document.getElementById(${js(id)}).disabled`);
const until = async (expression, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Right after a navigation the document may not be there yet: an error then means "not yet".
    if (await page(expression).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${what}`);
};
const banner = async (id) => ((await visible(id)) ? text(id) : '');
const inFolder = (name) => join(folder, name);

const steps = [];
const step = async (name, fn) => {
  await fn();
  steps.push(name);
  console.log(`ok - ${name}`);
};

// ---------- the run ----------

try {
  await step('without the token the page says so and the server answers nothing', async () => {
    await cdp('Page.navigate', { url: `${origin}/` });
    await until(`!document.getElementById('fatal').hidden`, 'the missing-token message');
    assert.match(await text('fatal'), /needs the token/);
    const res = await fetch(`${origin}/api/state`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    const other = await fetch(`${origin}/api/state`, { method: 'POST', headers: { Origin: 'http://evil.example', 'X-Hot-Token': token }, body: '{}' });
    assert.equal(other.status, 403);
  });

  await step('with the token it shows the network, the folder and what is set, and no secret', async () => {
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: openUrl });
    await until(`document.getElementById('network').textContent !== ''`, 'the page to load its state');
    assert.equal(await text('network'), network);
    assert.equal(await text('dir'), folder);
    const checks = await text('envChecks');
    assert.match(checks, /BLOCKFROST_PROJECT_ID is not set/);
    assert.match(checks, /sponsor wallet's secret is set/);
    assert.equal(await locked('s2'), true);
    assert.equal(await disabled('watchBtn'), true);
  });

  await step('refuses a cold-public.json for another network, or frames of another kind', async () => {
    await type('pubText', publicJson.replace('"preprod"', '"preview"'));
    await click('pubUse');
    await until(`!document.getElementById('pubErr').hidden`, 'the refusal');
    assert.match(await text('pubErr'), /for network "preview"/);
    await type('pubText', encodeFrames('tx', Buffer.from(txHex)).frames.join('\n'));
    await click('pubUse');
    await until(`document.getElementById('pubErr').textContent.includes('not "pubkey"')`, 'the wrong-kind refusal');
    assert.equal(existsSync(inFolder('cold-public.json')), false);
  });

  await step('accepts cold-public.json as MQR1 frames (kind pubkey) and shows the address and SHA-256', async () => {
    await type('pubText', encodeFrames('pubkey', Buffer.from(publicJson)).frames.join('\n'));
    await click('pubUse');
    await until(`document.getElementById('pubNow').textContent.includes('Watching')`, 'the address to show');
    const now = await text('pubNow');
    assert.ok(now.includes(own.address));
    assert.ok(now.includes(`SHA-256: ${sha256hex(Buffer.from(publicJson)).slice(0, 16)}...`));
    assert.equal(readFileSync(inFolder('cold-public.json'), 'utf8'), publicJson);
    assert.equal(await locked('s2'), false);
  });

  await step('Take a snapshot runs hot-watch and shows what it wrote', async () => {
    await click('watchBtn');
    await until(`!document.getElementById('snapOut').hidden && !document.getElementById('watchBtn').disabled`, 'hot-watch to finish');
    assert.match(await text('watchLog'), /ARGS \["cold-public\.json","cold-unshielded\.snapshot\.json"\]/);
    assert.equal(await banner('watchErr'), '');
    const kv = await text('snapKv');
    assert.match(kv, /5078500000 STAR \(5078\.500000 NIGHT\)/);
    assert.ok(kv.includes(`${sha256hex(Buffer.from(before)).slice(0, 16)}...`));
    assert.match(await text('snapChecks'), /for the watched address/);
  });

  await step('the snapshot as QR frames decodes in Node (kind snapshot) to the same file, with the same SHA-256', async () => {
    await click('snapQr');
    await until(`document.querySelector('#snapQrBox pre') !== null`, 'the QR codes');
    const back = decodeMqrText(await page(`document.querySelector('#snapQrBox pre').textContent`));
    assert.equal(back.kind, 'snapshot');
    assert.equal(back.payload.toString('utf8'), before);
    assert.ok((await text('snapQrBox')).includes(`SHA-256: ${sha256hex(back.payload).slice(0, 16)}...`));
    assert.ok(await page(`document.querySelector('#snapQrBox svg') !== null`));
  });

  await step('refuses a tx.hex that is not hex', async () => {
    await type('txText', 'hello; this is not hex');
    await click('txUse');
    await until(`!document.getElementById('txErr').hidden`, 'the refusal');
    assert.match(await text('txErr'), /not a tx\.hex/);
    assert.equal(existsSync(inFolder('tx.hex')), false);
    assert.equal(await locked('s4'), true);
  });

  await step('accepts tx.hex as MQR1 frames (kind tx) and shows the plan from the real hot-inspect', async () => {
    await type('txText', encodeFrames('tx', Buffer.from(txHex)).frames.join('\n'));
    await click('txUse');
    await until(`!document.getElementById('txOut').hidden`, 'the plan');
    assert.equal(readFileSync(inFolder('tx.hex'), 'utf8'), txHex);
    const head = await text('txBanner');
    assert.ok(head.includes(`SHA-256 ${sha256hex(Buffer.from(txHex)).slice(0, 16)}...`));
    assert.match(head, /checksum correct/);
    const shown = await text('txPlan');
    assert.ok(shown.includes(`From:     ${own.address}`));
    assert.ok(shown.includes(`To:       ${recipient}  1000000 STAR (1.000000 NIGHT)`));
    assert.match(shown, /Change: .* 79000000 STAR/);
    assert.equal(await locked('s4'), false);
    assert.equal(await locked('s5'), true);
  });

  await step('a dry run asks, and Cancel answers no: nothing is submitted', async () => {
    await click('dryRun');
    await click('submitStart');
    await until(`!document.getElementById('promptBox').hidden`, 'the SUBMIT question');
    assert.match(await text('promptText'), /Dry run/);
    assert.match(await text('submitLog'), /ARGS \["tx\.hex","--dry-run"\]/);
    await click('submitCancel');
    await until(`!document.getElementById('submitErr').hidden`, 'the cancellation');
    assert.match(await text('submitErr'), /Cancelled/);
    assert.equal(existsSync(inFolder('fake-submitted')), false);
    await click('dryRun');
  });

  await step('sponsor-submit waits for SUBMIT; anything else is refused', async () => {
    await until(`!document.getElementById('submitStart').disabled`, 'the start button');
    await click('submitStart');
    await until(`!document.getElementById('promptBox').hidden`, 'the SUBMIT question');
    const log = await text('submitLog');
    assert.match(log, /ARGS \["tx\.hex"\]/);
    assert.match(log, /Sponsor secret in the environment: yes/);
    assert.match(log, /Type SUBMIT to continue:/);
    for (const wrong of ['', 'submit', 'YES']) {
      await type('confirm', wrong);
      await click('confirmBtn');
      await until(`document.getElementById('submitErr').textContent.includes('Type SUBMIT')`, 'the refusal');
      assert.equal(existsSync(inFolder('fake-submitted')), false);
      assert.equal(await visible('promptBox'), true);
    }
  });

  await step('SUBMIT submits and the page reports the transaction id', async () => {
    await type('confirm', 'SUBMIT');
    await click('confirmBtn');
    await until(`!document.getElementById('submitDone').hidden`, 'the result');
    assert.ok((await text('submitDone')).includes(`Transaction ${'ab'.repeat(32)}`));
    assert.equal(await banner('submitErr'), '');
    assert.equal(existsSync(inFolder('fake-submitted')), true);
    assert.equal(await locked('s5'), false);
    assert.match(await text('landOut'), /Not seen yet: 1 of the 1 coin/);
  });

  await step('a fresh snapshot shows the spent coin gone: landed', async () => {
    await click('landBtn');
    await until(`document.getElementById('landOut').textContent.startsWith('Landed')`, 'the landing check');
    assert.match(await text('snapKv'), /5077500000 STAR \(5077\.500000 NIGHT\)/);
    assert.equal(readFileSync(inFolder('cold-unshielded.snapshot.json'), 'utf8'), after);
  });

  await step('through all of it: requests only to this server, no script error, no secret on the page', async () => {
    const elsewhere = requests.filter((u) => !u.startsWith(origin) && u !== 'about:blank' && !u.startsWith('blob:'));
    assert.deepEqual(elsewhere, []);
    assert.deepEqual(
      problems.filter((p) => !/403|400/.test(p)), // refused requests are logged by the browser as failed resources
      [],
    );
    assert.ok(!(await page(`document.documentElement.outerHTML`)).includes(MARKER));
    assert.equal(await page(`localStorage.length + sessionStorage.length`), 0);
  });

  // SCREENSHOT=file.png saves a picture of the whole page at the end, to look at the layout.
  if (process.env.SCREENSHOT) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(process.env.SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  console.log(`\n${steps.length} steps passed.`);
  process.exit(0);
} catch (e) {
  console.error(`\nFAILED after ${steps.length} step(s): ${e.stack ?? e}`);
  console.error(`Server output:\n${serverOut}`);
  process.exit(1);
}
