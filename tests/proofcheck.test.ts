import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProofServer, proofServerHelp } from '../src/proofcheck.js';

const answering = (status: number, body: string) => {
  const seen: string[] = [];
  const fetchFn = async (url: string) => {
    seen.push(url);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetchFn, seen };
};

test('a proof server that answers /version is reachable, and its version is shown', async () => {
  const a = answering(200, '9.0.2\n');
  assert.deepEqual(await checkProofServer('http://127.0.0.1:6300', a.fetchFn), { ok: true, version: '9.0.2' });
  assert.deepEqual(a.seen, ['http://127.0.0.1:6300/version']);
  const b = answering(200, '<html>');
  assert.deepEqual(await checkProofServer('http://host:6300/', b.fetchFn), { ok: true, version: '(unknown version)' });
  assert.deepEqual(b.seen, ['http://host:6300/version']);
});

test('a refused connection, an HTTP error and a timeout each fail with a reason', async () => {
  const refused = async () => {
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await checkProofServer('http://127.0.0.1:6300', refused), { ok: false, reason: 'could not connect' });
  assert.deepEqual(await checkProofServer('http://127.0.0.1:6300', answering(503, '').fetchFn), { ok: false, reason: 'it answered HTTP 503' });
  const slow = (_url: string, init: { signal: AbortSignal }) =>
    new Promise<never>((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  assert.deepEqual(await checkProofServer('http://127.0.0.1:6300', slow, 50), { ok: false, reason: 'no answer within 1 s' });
});

test('the help says whether PROOF_SERVER_URL is set, and never contains a URL', () => {
  const unset = proofServerHelp('could not connect', false).join('\n');
  assert.match(unset, /not set[\s\S]*port 6300[\s\S]*ssh -L/);
  const set = proofServerHelp('could not connect', true).join('\n');
  assert.match(set, /is set in this terminal/);
  assert.doesNotMatch(unset + set, /https?:\/\//);
});
