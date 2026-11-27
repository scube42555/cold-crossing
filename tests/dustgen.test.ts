import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectGenerations } from 'cold-crossing/dustgen.js';

const item = (generationMtIndex: number, over: Record<string, unknown> = {}) => ({
  __typename: 'DustGenerationsItem',
  commitmentMtIndex: 7,
  generationMtIndex,
  owner: 'ab'.repeat(32),
  value: '5000000000',
  initialValue: '0',
  backingNight: 'CD'.repeat(32),
  ctime: 1_794_000_000,
  transactionId: 12,
  transactionHash: 'EF'.repeat(32),
  ...over,
});

test('collectGenerations: reads entries in tree order with amounts and times', () => {
  const r = collectGenerations([item(9, { value: '80000000' }), { __typename: 'DustGenerationsProgress', highestIndex: 9 }, item(3)]);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map((e) => e.generationMtIndex), [3, 9]);
  assert.equal(r.entries[0].nightValue, 5_000_000_000n);
  assert.equal(r.entries[1].nightValue, 80_000_000n);
  assert.equal(r.entries[0].ctime.getTime(), 1_794_000_000_000);
  assert.equal(r.entries[0].backingNight, 'cd'.repeat(32));
  assert.equal(r.entries[0].transactionHash, 'ef'.repeat(32));
  assert.equal(r.entries[0].dtime, undefined);
  assert.equal(r.progressSeen, true);
  assert.equal(r.ignored, 0);
});

test('collectGenerations: a dtime update marks its entry as stopped, whichever arrives first', () => {
  const stop = { __typename: 'DustGenerationDtimeUpdateItem', generationMtIndex: 3, newDtime: 1_794_100_000, nightUtxoHash: 'aa', treeInsertionPath: 'bb' };
  for (const messages of [[item(3), stop], [stop, item(3)]]) {
    const r = collectGenerations(messages);
    assert.equal(r.entries[0].dtime?.getTime(), 1_794_100_000_000);
  }
  // an update for an entry that was not sent changes nothing
  assert.equal(collectGenerations([item(4), stop]).entries[0].dtime, undefined);
});

test('collectGenerations: malformed or unknown messages are counted, not guessed at', () => {
  const r = collectGenerations([
    null,
    'text',
    [],
    { __typename: 'SomethingNew' },
    item(1, { value: '-5' }),
    item(1, { value: 5 }),
    item(1, { initialValue: '1e9' }),
    item(1, { ctime: 'yesterday' }),
    item(1, { generationMtIndex: -1 }),
    item(1, { backingNight: 'not hex' }),
    { __typename: 'DustGenerationDtimeUpdateItem', generationMtIndex: 1, newDtime: 'soon' },
    item(2),
  ]);
  assert.equal(r.ignored, 11);
  assert.deepEqual(r.entries.map((e) => e.generationMtIndex), [2]);
});

test('collectGenerations: nothing in, nothing out', () => {
  assert.deepEqual(collectGenerations([]), { entries: [], progressSeen: false, ignored: 0 });
});
