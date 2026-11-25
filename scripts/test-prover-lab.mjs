// Drives dist/prover-lab.html in headless Chromium: loads the key files through the file picker, proves one shielded
// output, and checks the page reports a verified proof. Fails if the page requests anything but its own file.
//   npm run build:prover-lab && node scripts/test-prover-lab.mjs [prover-keys folder]
// Needs Chromium (set CHROMIUM to its path if it is not `chromium`). Proving takes about a minute.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const keysDir = resolve(process.argv[2] ?? 'prover-keys');
const keyFiles = readdirSync(keysDir).filter((f) => f !== 'SHA256SUMS').map((f) => join(keysDir, f));
const pageUrl = pathToFileURL(resolve('dist/prover-lab.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'prover-lab-test-'));
const chromium = spawn(
  process.env.CHROMIUM ?? 'chromium',
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--no-sandbox', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const cleanUp = () => {
  chromium.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
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
for (const d of ['Network', 'Runtime', 'Log', 'Page', 'DOM']) await cdp(`${d}.enable`);

const page = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const until = async (expression, what, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page(expression)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for: ${what}\nLog:\n${await page("document.getElementById('log').textContent")}`);
};

await cdp('Page.navigate', { url: pageUrl });
await until("document.getElementById('log')?.textContent.includes('Modules ready.')", 'the WebAssembly modules to load', 60_000);

// A file that is not pinned must be rejected and leave the button disabled.
const { root } = await cdp('DOM.getDocument', {});
const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#pick' });
await cdp('DOM.setFileInputFiles', { nodeId, files: [resolve('package.json')] });
await until("document.getElementById('log').textContent.includes('Rejected package.json')", 'an unpinned file to be rejected', 10_000);
assert.equal(await page("document.getElementById('run').disabled"), true, 'button enabled with no key files');

await cdp('DOM.setFileInputFiles', { nodeId, files: keyFiles });
await until("!document.getElementById('run').disabled", 'all four key files to be accepted', 30_000);

const t0 = Date.now();
await page("document.getElementById('run').click()");
await until(
  "document.getElementById('result').dataset.verified === 'yes' || !document.getElementById('error').hidden",
  'the proof to finish',
  10 * 60_000,
);
const error = await page("document.getElementById('error').hidden ? '' : document.getElementById('error').textContent");
assert.equal(error, '', `the page reported: ${error}`);
const result = await page("document.getElementById('result-text').textContent");
console.log(result);
console.log(`(wall clock in the test: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const foreign = requests.filter((u) => u !== pageUrl);
assert.deepEqual(foreign, [], `the page made network requests: ${foreign.join(', ')}`);
assert.deepEqual(problems, [], `the page logged errors:\n${problems.join('\n')}`);
console.log('prover lab: OK (verified proof, no requests beyond the page itself)');
process.exit(0);
