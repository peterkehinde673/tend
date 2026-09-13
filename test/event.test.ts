import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateTendEvent, isTendEventSource, isTendEventType, isTendMotionSubType, TendEvent } from '../src/domain/event';

function validEvent(overrides: Partial<TendEvent> = {}): Partial<TendEvent> {
  return {
    householdId: 'house-1',
    deviceId: 'device-kitchen-01',
    eventId: 'evt-1',
    requestId: 'req-1',
    eventType: 'motion_detected',
    subType: 'human',
    occurredAt: '2026-09-14T07:30:00.000Z',
    ingestedAt: '2026-09-14T07:30:01.000Z',
    source: 'dev_simulator',
    rawEventId: 'raw-1',
    ...overrides,
  };
}

describe('domain/event: validateTendEvent', () => {
  test('accepts a fully valid event', () => {
    const problems = validateTendEvent(validEvent());
    assert.deepEqual(problems, []);
  });

  test('rejects an event missing required string fields', () => {
    const problems = validateTendEvent(validEvent({ householdId: undefined, deviceId: '' }));
    assert.ok(problems.some((p) => p.includes('householdId')));
    assert.ok(problems.some((p) => p.includes('deviceId')));
  });

  test('rejects an unsupported eventType', () => {
    // Cast through unknown deliberately: we are testing that a bad value
    // supplied at a system boundary (e.g. a malformed payload) is rejected,
    // not writing production code that would ever produce this shape.
    const problems = validateTendEvent(validEvent({ eventType: 'something_else' as unknown as TendEvent['eventType'] }));
    assert.ok(problems.some((p) => p.includes('eventType')));
  });

  test('rejects an unsupported subType', () => {
    const problems = validateTendEvent(validEvent({ subType: 'ghost' as unknown as TendEvent['subType'] }));
    assert.ok(problems.some((p) => p.includes('subType')));
  });

  test('rejects a missing/invalid source', () => {
    const problems = validateTendEvent(validEvent({ source: 'made_up_source' as unknown as TendEvent['source'] }));
    assert.ok(problems.some((p) => p.includes('source')));
  });

  test('rejects a malformed occurredAt timestamp', () => {
    const problems = validateTendEvent(validEvent({ occurredAt: 'not-a-date' }));
    assert.ok(problems.some((p) => p.includes('occurredAt')));
  });

  test('accepts an event without subType (e.g. button_press)', () => {
    const problems = validateTendEvent(
      validEvent({ eventType: 'button_press', subType: undefined }),
    );
    assert.deepEqual(problems, []);
  });
});

describe('domain/event: type guards', () => {
  test('isTendEventType distinguishes valid from invalid values', () => {
    assert.equal(isTendEventType('motion_detected'), true);
    assert.equal(isTendEventType('button_press'), true);
    assert.equal(isTendEventType('not_a_type'), false);
    assert.equal(isTendEventType(42), false);
  });

  test('isTendMotionSubType distinguishes valid from invalid values', () => {
    assert.equal(isTendMotionSubType('human'), true);
    assert.equal(isTendMotionSubType('vehicle'), true);
    assert.equal(isTendMotionSubType('ghost'), false);
  });

  test('isTendEventSource never accepts ring_real/ring_playground as a typo-tolerant match', () => {
    assert.equal(isTendEventSource('ring_real'), true);
    assert.equal(isTendEventSource('ring_playground'), true);
    assert.equal(isTendEventSource('dev_simulator'), true);
    assert.equal(isTendEventSource('ring-real'), false); // wrong delimiter must not silently pass
    assert.equal(isTendEventSource(''), false);
  });
});
