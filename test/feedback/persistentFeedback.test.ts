import assert from 'node:assert/strict';
import { FeedbackEvent, SignalSensitivity } from '../../src/domain/feedback';
import { DEFAULT_CONFIG } from '../../src/config/config';
import { applyPersistentFeedback } from '../../src/feedback/persistentFeedback';
import { InMemorySensitivityStore } from '../../src/feedback/sensitivityStoreFactory';

function feedback(type: FeedbackEvent['feedbackType'], timestamp: string, signal = 'presence'): FeedbackEvent {
  return {
    householdId: 'household-1',
    deviationId: 'deviation-1',
    feedbackType: type,
    affectedSignals: [signal],
    timestamp,
  };
}

async function run(): Promise<void> {
  const store = new InMemorySensitivityStore();

  const first = await applyPersistentFeedback(
    store,
    feedback('not_useful', '2026-01-01T10:00:00.000Z'),
    DEFAULT_CONFIG,
  );
  assert.equal(first[0].multiplier, 1.1, 'first feedback should apply one minimal nudge');

  const second = await applyPersistentFeedback(
    store,
    feedback('not_useful', '2026-01-02T10:00:00.000Z'),
    DEFAULT_CONFIG,
  );
  assert.ok(second[0].multiplier > 1.1, 'corroborating feedback should increase the adjustment');

  const keepWatching = await applyPersistentFeedback(
    store,
    feedback('keep_watching', '2026-01-03T10:00:00.000Z'),
    DEFAULT_CONFIG,
  );
  assert.ok(keepWatching[0].multiplier < second[0].multiplier, 'time decay should still apply before a no-op feedback');

  const other = await applyPersistentFeedback(
    store,
    feedback('unusual', '2026-01-03T10:00:00.000Z', 'sequence'),
    DEFAULT_CONFIG,
  );
  assert.equal(other[0].multiplier, 0.9, 'new signals start at default and receive the unusual nudge');

  const persisted = await store.get('household-1', 'presence');
  assert.deepEqual(persisted, keepWatching[0], 'updated state must be persisted and reloadable');

  // Verify the persistence boundary does not mutate an object returned by get.
  const detachedStore = new InMemorySensitivityStore();
  const initial: SignalSensitivity = {
    householdId: 'household-2',
    signal: 'timing',
    multiplier: 1,
    lastUpdatedAt: new Date(0).toISOString(),
    recentFeedback: [],
  };
  await detachedStore.put(initial);
  const loaded = await detachedStore.get('household-2', 'timing');
  assert.equal(loaded.multiplier, 1);

  console.log('persistent feedback tests passed');
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
