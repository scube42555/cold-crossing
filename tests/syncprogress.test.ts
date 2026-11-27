import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress, progressLine, saveIntervalMs, sponsorNotice, syncLogIntervalMs } from 'cold-crossing/syncprogress.js';

const done = { isStrictlyComplete: () => true, appliedIndex: 10n, highestRelevantWalletIndex: 10n };
const part = (applied: bigint, target: bigint) => ({ isStrictlyComplete: () => false, appliedIndex: applied, highestRelevantWalletIndex: target });

test('progress reads like the wnight sync log', () => {
  assert.equal(describeProgress(done), 'done');
  assert.equal(describeProgress(part(423n, 1000n)), '42.3%');
  assert.equal(describeProgress(part(1000n, 1000n)), '99.9%'); // held below 100 until the SDK says complete
  assert.equal(describeProgress(part(0n, 0n)), 'starting');
  assert.equal(describeProgress({ isStrictlyComplete: () => false, appliedId: 5n, highestTransactionId: 10n }), '50.0%');
  assert.equal(describeProgress(undefined), 'syncing');
  const a = progressLine({ shielded: done, unshielded: part(1n, 2n), dust: part(0n, 0n) }, 7, 30);
  assert.equal(a.line, 'Sync (30 s): shielded done, unshielded 50.0%, dust starting (update 7)');
  const b = progressLine({ shielded: done, unshielded: done, dust: part(0n, 0n) }, 8, 31);
  assert.notEqual(a.key, b.key); // a part finishing always prints a line
});

test('intervals come from the environment, with safe defaults', () => {
  assert.equal(syncLogIntervalMs({}), 15_000);
  assert.equal(syncLogIntervalMs({ MIDNIGHT_SYNC_LOG_INTERVAL_MS: '60000' }), 60_000);
  assert.equal(syncLogIntervalMs({ MIDNIGHT_SYNC_LOG_INTERVAL_MS: 'x' }), 15_000);
  assert.equal(syncLogIntervalMs({ MIDNIGHT_SYNC_LOG_INTERVAL_MS: '5' }), 15_000);
  assert.equal(saveIntervalMs({}), 300_000);
  assert.equal(saveIntervalMs({ MIDNIGHT_WALLET_SAVE_INTERVAL_MS: '60000' }), 60_000);
});

test('the sponsor notice warns early when nothing is synced, and nudges when the state is old', () => {
  const now = Date.UTC(2026, 10, 25);
  const name = 'wallet-state-mn_addr_preprod1rwkswmczy5przerxkwn5anxtgjge40a5m6cputamv9styeplzx3q222lwj.json';
  const none = sponsorNotice([{ name: 'tx.hex', mtimeMs: now }], now, '/hot');
  assert.equal(none.level, 'warn');
  assert.match(none.lines.join('\n'), /no saved sponsor state[\s\S]*hot:sponsor-sync/);
  const fresh = sponsorNotice([{ name, mtimeMs: now - 2 * 3600_000 }], now, '/hot');
  assert.equal(fresh.level, 'ok');
  assert.match(fresh.lines.join('\n'), /mn_addr_preprod1rw.*222lwj  last saved 2\.0 h ago/);
  assert.doesNotMatch(fresh.lines.join('\n'), /hot:sponsor-sync/);
  const old = sponsorNotice([{ name, mtimeMs: now - 12 * 24 * 3600_000 }], now, '/hot');
  assert.equal(old.level, 'info');
  assert.match(old.lines.join('\n'), /12\.0 days ago[\s\S]*hot:sponsor-sync/);
});
