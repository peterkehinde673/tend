import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HouseholdSimulator } from '../src/ingestion/simulator';
import { validateTendEvent } from '../src/domain/event';

const REFERENCE_DATE = new Date('2026-09-14T00:00:00.000Z'); // Monday

describe('ingestion/simulator: determinism', () => {
  test('same seed + date + scenario always produces identical output', () => {
    const simA = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    const simB = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });

    const a = simA.generateDay(REFERENCE_DATE, 'normal');
    const b = simB.generateDay(REFERENCE_DATE, 'normal');

    assert.deepEqual(a, b);
  });

  test('different seeds produce different jitter (not identical timing)', () => {
    const simA = new HouseholdSimulator({ householdId: 'house-1', seed: 1 });
    const simB = new HouseholdSimulator({ householdId: 'house-1', seed: 999 });

    const a = simA.generateDay(REFERENCE_DATE, 'normal');
    const b = simB.generateDay(REFERENCE_DATE, 'normal');

    const anyDifferent = a.some((event, i) => event.occurredAt !== b[i].occurredAt);
    assert.ok(anyDifferent, 'expected different seeds to produce different jitter');
  });

  test('every generated event is schema-valid and tagged as dev_simulator', () => {
    const sim = new HouseholdSimulator({ householdId: 'house-1', seed: 7 });
    for (const scenario of ['normal', 'deviation_missing', 'variable_normal', 'sequence_deviation'] as const) {
      const events = sim.generateDay(REFERENCE_DATE, scenario);
      for (const event of events) {
        const problems = validateTendEvent(event);
        assert.deepEqual(problems, [], `scenario ${scenario} produced an invalid event: ${JSON.stringify(event)}`);
        assert.equal(event.source, 'dev_simulator');
      }
    }
  });
});

describe('ingestion/simulator: scenario shapes', () => {
  test('normal scenario produces the full 4-event routine', () => {
    const sim = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    const events = sim.generateDay(REFERENCE_DATE, 'normal');
    assert.equal(events.length, 4);
    const zones = events.map((e) => e.zoneId);
    assert.deepEqual(zones, ['kitchen', 'entrance', 'kitchen', 'bedroom']);
  });

  test('deviation_missing scenario truncates the routine after entrance activity', () => {
    const sim = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    const events = sim.generateDay(REFERENCE_DATE, 'deviation_missing');
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.zoneId),
      ['kitchen', 'entrance'],
    );
  });

  test('variable_normal scenario still produces all 4 events, with larger jitter than normal', () => {
    const sim = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    const normalEvents = sim.generateDay(REFERENCE_DATE, 'normal');
    const variableEvents = sim.generateDay(REFERENCE_DATE, 'variable_normal');
    assert.equal(variableEvents.length, 4);
    // Same zone sequence as normal, since it's a "still normal, just noisier" day.
    assert.deepEqual(
      variableEvents.map((e) => e.zoneId),
      normalEvents.map((e) => e.zoneId),
    );
  });

  test('sequence_deviation scenario keeps the same 4 zones but in a different order', () => {
    const sim = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    const normalEvents = sim.generateDay(REFERENCE_DATE, 'normal');
    const seqEvents = sim.generateDay(REFERENCE_DATE, 'sequence_deviation');

    const normalZones = normalEvents.map((e) => e.zoneId).sort();
    const seqZones = seqEvents.map((e) => e.zoneId).sort();
    assert.deepEqual(seqZones, normalZones, 'same set of zones should appear');

    const normalOrder = normalEvents.map((e) => e.zoneId);
    const seqOrder = seqEvents.map((e) => e.zoneId);
    assert.notDeepEqual(seqOrder, normalOrder, 'order should differ from the normal routine');
  });
});

describe('ingestion/simulator: historical window seeding', () => {
  test('generateHistoricalWindow produces the requested number of distinct days, all before endDateExclusive', () => {
    const sim = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    const events = sim.generateHistoricalWindow(REFERENCE_DATE, 14);

    const distinctDays = new Set(events.map((e) => e.occurredAt.slice(0, 10)));
    assert.equal(distinctDays.size, 14);

    for (const event of events) {
      assert.ok(Date.parse(event.occurredAt) < REFERENCE_DATE.getTime());
    }
  });

  test('historical window is fully reproducible given the same seed', () => {
    const simA = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    const simB = new HouseholdSimulator({ householdId: 'house-1', seed: 42 });
    assert.deepEqual(simA.generateHistoricalWindow(REFERENCE_DATE, 14), simB.generateHistoricalWindow(REFERENCE_DATE, 14));
  });
});
