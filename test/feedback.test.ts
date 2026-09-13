import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SensitivityStore, applyFeedback } from '../src/feedback/feedbackEngine';
import { FeedbackEvent } from '../src/domain/feedback';
import { DEFAULT_CONFIG } from '../src/config/config';

function makeFeedback(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    householdId: 'house-1',
    deviationId: 'dev-1',
    feedbackType: 'expected',
    affectedSignals: ['kitchen_presence'],
    timestamp: '2026-09-14T09:00:00.000Z',
    ...overrides,
  };
}

describe('feedback/feedbackEngine: defaults and bounds', () => {
  test('a signal with no feedback yet has the default multiplier', () => {
    const store = new SensitivityStore();
    const state = store.get('house-1', 'kitchen_presence');
    assert.equal(state.multiplier, DEFAULT_CONFIG.feedback.defaultMultiplier);
  });

  test('multiplier never exceeds the configured max, even after many "expected" events', () => {
    const store = new SensitivityStore();
    let timestamp = Date.parse('2026-09-14T09:00:00.000Z');
    for (let i = 0; i < 50; i++) {
      applyFeedback(store, makeFeedback({ timestamp: new Date(timestamp).toISOString() }));
      timestamp += 24 * 60 * 60 * 1000; // one day apart, so decay does not fully cancel each nudge
    }
    const state = store.get('house-1', 'kitchen_presence');
    assert.ok(state.multiplier <= DEFAULT_CONFIG.feedback.maxMultiplier);
  });

  test('multiplier never drops below the configured min, even after many "unusual" events', () => {
    const store = new SensitivityStore();
    let timestamp = Date.parse('2026-09-14T09:00:00.000Z');
    for (let i = 0; i < 50; i++) {
      applyFeedback(store, makeFeedback({ feedbackType: 'unusual', timestamp: new Date(timestamp).toISOString() }));
      timestamp += 24 * 60 * 60 * 1000;
    }
    const state = store.get('house-1', 'kitchen_presence');
    assert.ok(state.multiplier >= DEFAULT_CONFIG.feedback.minMultiplier);
  });
});

describe('feedback/feedbackEngine: conservative single-event update', () => {
  test('a single "expected" event only applies one minimal nudge, not a large jump', () => {
    const store = new SensitivityStore();
    const [result] = applyFeedback(store, makeFeedback({ feedbackType: 'expected' }));
    const expectedMax = DEFAULT_CONFIG.feedback.defaultMultiplier + DEFAULT_CONFIG.feedback.nudgeStep;
    assert.ok(
      result.multiplier <= expectedMax + 1e-9,
      `single feedback event should not exceed one nudge step above default; got ${result.multiplier}`,
    );
    assert.ok(result.multiplier > DEFAULT_CONFIG.feedback.defaultMultiplier);
  });

  test('a single "unusual" event nudges sensitivity down, not up', () => {
    const store = new SensitivityStore();
    const [result] = applyFeedback(store, makeFeedback({ feedbackType: 'unusual' }));
    assert.ok(result.multiplier < DEFAULT_CONFIG.feedback.defaultMultiplier);
  });

  test('"keep_watching" is a strict no-op on the multiplier', () => {
    const store = new SensitivityStore();
    const [result] = applyFeedback(store, makeFeedback({ feedbackType: 'keep_watching' }));
    assert.equal(result.multiplier, DEFAULT_CONFIG.feedback.defaultMultiplier);
  });

  test('"not_useful" nudges sensitivity up (less sensitive), same direction as "expected"', () => {
    const store = new SensitivityStore();
    const [result] = applyFeedback(store, makeFeedback({ feedbackType: 'not_useful' }));
    assert.ok(result.multiplier > DEFAULT_CONFIG.feedback.defaultMultiplier);
  });
});

describe('feedback/feedbackEngine: corroboration gating', () => {
  test('a second corroborating event within the window applies a larger cumulative move than the first alone', () => {
    const store = new SensitivityStore();
    const t1 = '2026-09-14T09:00:00.000Z';
    const t2 = '2026-09-15T09:00:00.000Z'; // 1 day later, well within the 30-day corroboration window

    const [afterFirst] = applyFeedback(store, makeFeedback({ feedbackType: 'expected', timestamp: t1 }));
    const [afterSecond] = applyFeedback(store, makeFeedback({ feedbackType: 'expected', timestamp: t2 }));

    assert.ok(afterSecond.multiplier > afterFirst.multiplier, 'corroborated feedback should move further than a single event');
  });

  test('corroboration only counts matching feedback types, not mixed types', () => {
    const store = new SensitivityStore();
    const t1 = '2026-09-14T09:00:00.000Z';
    const t2 = '2026-09-15T09:00:00.000Z';

    applyFeedback(store, makeFeedback({ feedbackType: 'expected', timestamp: t1 }));
    const [afterOpposite] = applyFeedback(store, makeFeedback({ feedbackType: 'unusual', timestamp: t2 }));

    // The "unusual" event should apply only its own minimal nudge relative
    // to the decayed state, not benefit from the earlier "expected" event's
    // corroboration count.
    const singleUnusualNudge = DEFAULT_CONFIG.feedback.nudgeStep;
    // Compute the decayed baseline just before the unusual nudge to bound the expected result loosely.
    assert.ok(afterOpposite.multiplier < DEFAULT_CONFIG.feedback.defaultMultiplier + DEFAULT_CONFIG.feedback.nudgeStep, 'should not corroborate across different feedback types');
    assert.ok(afterOpposite.multiplier >= DEFAULT_CONFIG.feedback.defaultMultiplier - 2 * singleUnusualNudge - 1e-9);
  });
});

describe('feedback/feedbackEngine: decay behavior', () => {
  test('a stale nudge decays back toward the default multiplier over time', () => {
    const store = new SensitivityStore();
    const t1 = '2026-09-14T09:00:00.000Z';
    const [afterFirst] = applyFeedback(store, makeFeedback({ feedbackType: 'expected', timestamp: t1 }));
    const distanceAtStart = afterFirst.multiplier - DEFAULT_CONFIG.feedback.defaultMultiplier;

    // Apply a neutral "keep_watching" long after, which is a no-op nudge but
    // still passes through the decay calculation for elapsed time.
    const muchLater = new Date(Date.parse(t1) + DEFAULT_CONFIG.feedback.decayHalfLifeDays * 24 * 60 * 60 * 1000).toISOString();
    const [afterDecay] = applyFeedback(store, makeFeedback({ feedbackType: 'keep_watching', timestamp: muchLater }));
    const distanceAfterHalfLife = afterDecay.multiplier - DEFAULT_CONFIG.feedback.defaultMultiplier;

    assert.ok(
      Math.abs(distanceAfterHalfLife) < Math.abs(distanceAtStart),
      'distance from default should shrink after one half-life has elapsed',
    );
    assert.ok(
      Math.abs(distanceAfterHalfLife - distanceAtStart / 2) < 1e-6,
      `expected roughly half the original distance after one half-life; start=${distanceAtStart}, after=${distanceAfterHalfLife}`,
    );
  });
});

describe('feedback/feedbackEngine: multi-signal feedback', () => {
  test('one feedback event affecting multiple signals updates all of them independently', () => {
    const store = new SensitivityStore();
    const results = applyFeedback(
      store,
      makeFeedback({ feedbackType: 'unusual', affectedSignals: ['kitchen_presence', 'entrance_timing'] }),
    );
    assert.equal(results.length, 2);
    const kitchen = store.get('house-1', 'kitchen_presence');
    const entrance = store.get('house-1', 'entrance_timing');
    assert.ok(kitchen.multiplier < DEFAULT_CONFIG.feedback.defaultMultiplier);
    assert.ok(entrance.multiplier < DEFAULT_CONFIG.feedback.defaultMultiplier);
  });
});
