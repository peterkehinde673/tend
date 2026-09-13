import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdBaseline } from '../src/engine/baselineEngine';
import { TendEvent } from '../src/domain/event';
import { DEFAULT_CONFIG } from '../src/config/config';

/** 2026-09-14 is a Monday (confirmed: getUTCDay() === 1). */
const AS_OF = new Date('2026-09-14T00:00:00.000Z');

function isoAtMinutes(dateKey: string, minutesSinceMidnight: number): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return new Date(d.getTime() + minutesSinceMidnight * 60_000).toISOString();
}

function makeEvent(dateKey: string, minutesSinceMidnight: number, zoneId: string, index: number): TendEvent {
  return {
    householdId: 'house-1',
    deviceId: `device-${zoneId}-01`,
    zoneId,
    eventId: `evt-${dateKey}-${zoneId}-${index}`,
    requestId: `req-${dateKey}-${zoneId}-${index}`,
    eventType: 'motion_detected',
    subType: 'human',
    occurredAt: isoAtMinutes(dateKey, minutesSinceMidnight),
    ingestedAt: isoAtMinutes(dateKey, minutesSinceMidnight),
    source: 'dev_simulator',
    rawEventId: `raw-${dateKey}-${zoneId}-${index}`,
  };
}

// The 10 weekdays in the 14 days strictly before 2026-09-14, confirmed via
// getUTCDay(): Mon Aug31, Tue Sep1, Wed Sep2, Thu Sep3, Fri Sep4, Mon Sep7,
// Tue Sep8, Wed Sep9, Thu Sep10, Fri Sep11. (Sep5/6/12/13 are weekend.)
const TEN_WEEKDAYS = [
  '2026-08-31',
  '2026-09-01',
  '2026-09-02',
  '2026-09-03',
  '2026-09-04',
  '2026-09-07',
  '2026-09-08',
  '2026-09-09',
  '2026-09-10',
  '2026-09-11',
];

const TWO_WEEKEND_DAYS = ['2026-09-05', '2026-09-06']; // Sat, Sun

describe('engine/baselineEngine: hand-verifiable dataset', () => {
  test('10 consecutive weekday occurrences at 07:30 yield the expected EWMA, timing stats, and confidence', () => {
    const events: TendEvent[] = TEN_WEEKDAYS.map((day, i) => makeEvent(day, 7 * 60 + 30, 'kitchen', i));
    const baseline = buildHouseholdBaseline('house-1', events, AS_OF, DEFAULT_CONFIG, 14);

    assert.equal(baseline.daysObserved, 10);
    assert.equal(baseline.confidence, 10 / 14);

    // Bucket for 07:30 = floor(450/30) = 15.
    const kitchenBuckets = baseline.bucketStats['kitchen'];
    assert.ok(kitchenBuckets, 'expected bucket stats for the "kitchen" signal');
    const bucket15Weekday = kitchenBuckets!.find((b) => b.bucketIndex === 15 && b.dayType === 'weekday');
    assert.ok(bucket15Weekday);
    assert.equal(bucket15Weekday!.daysObserved, 10);

    // EWMA with alpha=0.2 over 10 consecutive occurrences of activity=1,
    // starting from 0: prob_n = 1 - (1 - alpha)^n = 1 - 0.8^10.
    const expectedProb = 1 - Math.pow(0.8, 10);
    assert.ok(
      Math.abs(bucket15Weekday!.activityProbability - expectedProb) < 1e-9,
      `expected ~${expectedProb}, got ${bucket15Weekday!.activityProbability}`,
    );

    // Timing: identical time every day => mean=450, std=0.
    const kitchenTiming = baseline.timingStats['kitchen']!.find((t) => t.dayType === 'weekday');
    assert.ok(kitchenTiming);
    assert.equal(kitchenTiming!.meanFirstActivityMinutes, 450);
    assert.equal(kitchenTiming!.stdFirstActivityMinutes, 0);
    assert.equal(kitchenTiming!.daysObserved, 10);

    // No weekend data was supplied at all.
    const weekendTiming = baseline.timingStats['kitchen']!.find((t) => t.dayType === 'weekend');
    assert.equal(weekendTiming!.daysObserved, 0);
  });

  test('weekday and weekend buckets are tracked separately from mixed data', () => {
    const weekdayEvents = TEN_WEEKDAYS.map((day, i) => makeEvent(day, 7 * 60 + 30, 'kitchen', i));
    const weekendEvents = TWO_WEEKEND_DAYS.map((day, i) => makeEvent(day, 9 * 60 + 0, 'kitchen', 100 + i)); // 09:00 on weekends
    const baseline = buildHouseholdBaseline('house-1', [...weekdayEvents, ...weekendEvents], AS_OF, DEFAULT_CONFIG, 14);

    const kitchenTimingWeekday = baseline.timingStats['kitchen']!.find((t) => t.dayType === 'weekday');
    const kitchenTimingWeekend = baseline.timingStats['kitchen']!.find((t) => t.dayType === 'weekend');

    assert.equal(kitchenTimingWeekday!.meanFirstActivityMinutes, 450); // 07:30
    assert.equal(kitchenTimingWeekend!.meanFirstActivityMinutes, 540); // 09:00
    assert.equal(kitchenTimingWeekend!.daysObserved, 2);
  });

  test('insufficient data yields low confidence proportional to days observed', () => {
    const events = [makeEvent('2026-09-11', 450, 'kitchen', 0), makeEvent('2026-09-10', 450, 'kitchen', 1), makeEvent('2026-09-09', 450, 'kitchen', 2)];
    const baseline = buildHouseholdBaseline('house-1', events, AS_OF, DEFAULT_CONFIG, 14);
    assert.equal(baseline.daysObserved, 3);
    assert.equal(baseline.confidence, 3 / 14);
  });

  test('confidence is clamped to 1.0 even when more days of data exist than the requested window', () => {
    const events = TEN_WEEKDAYS.map((day, i) => makeEvent(day, 450, 'kitchen', i));
    const baseline = buildHouseholdBaseline('house-1', events, AS_OF, DEFAULT_CONFIG, 5);
    assert.ok(baseline.daysObserved <= 5);
    assert.ok(baseline.confidence <= 1.0);
  });

  test('events outside the rolling window are excluded entirely', () => {
    const insideWindow = makeEvent('2026-09-11', 450, 'kitchen', 0);
    const outsideWindow = makeEvent('2026-08-01', 450, 'kitchen', 1); // long before the 14-day window
    const baseline = buildHouseholdBaseline('house-1', [insideWindow, outsideWindow], AS_OF, DEFAULT_CONFIG, 14);
    assert.equal(baseline.daysObserved, 1);
  });

  test('transition stats capture a simple learned sequence', () => {
    // kitchen -> entrance every weekday at the same times.
    const events: TendEvent[] = [];
    TEN_WEEKDAYS.forEach((day, i) => {
      events.push(makeEvent(day, 450, 'kitchen', i)); // 07:30
      events.push(makeEvent(day, 462, 'entrance', i)); // 07:42
    });
    const baseline = buildHouseholdBaseline('house-1', events, AS_OF, DEFAULT_CONFIG, 14);

    const transition = baseline.transitionStats.find((t) => t.fromZoneId === 'kitchen' && t.bucketIndex === 15 && t.dayType === 'weekday');
    assert.ok(transition, 'expected a learned kitchen(bucket15)->? transition on weekdays');
    assert.equal(transition!.observedTransitions, 10);
    assert.equal(transition!.nextZoneProbabilities['entrance'], 1);
  });
});
