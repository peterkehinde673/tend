import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoState } from '../../src/dev/demoState';

test('first dashboard snapshot includes events for its default selected scenario', async () => {
  const today = new Date('2026-09-14T00:00:00.000Z');
  const asOf = new Date('2026-09-14T09:00:00.000Z');
  const state = new DemoState();

  const snapshot = await state.snapshot(today, asOf);

  assert.equal(snapshot.scenario, 'deviation_missing');
  assert.ok(
    snapshot.recentEvents.some((event) => event.occurredAt.startsWith('2026-09-14')),
    'initial snapshot should include simulated events for the demo day',
  );
  assert.notEqual(
    snapshot.deviation.compositeScore,
    0,
    'default deviation scenario should not be evaluated against an empty day',
  );
});
