import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRingHistoryEntry } from '../../src/ingestion/ring/ringNormalizer';
import { RingRawHistoryEntry } from '../../src/ingestion/ring/ringTypes';
import { validateTendEvent } from '../../src/domain/event';

/**
 * IMPORTANT CONTEXT FOR THESE TESTS: the Ring Event History API's exact
 * response shape has NOT been captured from official documentation (see
 * ringTypes.ts). These fixtures are this project's own best-effort,
 * documented-as-assumed construction, not a copied real example — the
 * tests below verify normalizeRingHistoryEntry's own parsing/rejection
 * logic against that assumed shape, not Ring's actual live behavior.
 */

function motionEntry(overrides: Partial<NonNullable<RingRawHistoryEntry['attributes']>> = {}): RingRawHistoryEntry {
  return {
    id: 'hist-evt-1',
    type: 'device-events',
    attributes: {
      kind: 'motion',
      occurred_at: '2026-09-14T07:30:00.000Z',
      sub_type: 'human',
      ...overrides,
    },
  };
}

describe('ring/ringNormalizer: normalizeRingHistoryEntry — documented/production motion entries', () => {
  test('normalizes a well-formed "motion" kind entry into a schema-valid TendEvent', () => {
    const result = normalizeRingHistoryEntry(motionEntry(), 'device-kitchen-01', 'house-1', 'ring_real');
    assert.ok('event' in result, `expected success, got: ${JSON.stringify(result)}`);
    if ('event' in result) {
      assert.equal(result.event.eventType, 'motion_detected');
      assert.equal(result.event.subType, 'human');
      assert.equal(result.event.source, 'ring_real');
      assert.equal(result.event.deviceId, 'device-kitchen-01');
      assert.equal(result.event.occurredAt, '2026-09-14T07:30:00.000Z');
      assert.deepEqual(validateTendEvent(result.event), []);
    }
  });

  test('accepts an occurred-at timestamp under the "time" field name as a fallback', () => {
    const entry: RingRawHistoryEntry = { id: 'hist-2', attributes: { kind: 'motion', time: '2026-09-14T08:00:00.000Z' } };
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('event' in result);
  });

  test('accepts an occurred-at timestamp under the "timestamp" field name as a fallback', () => {
    const entry: RingRawHistoryEntry = { id: 'hist-3', attributes: { kind: 'motion', timestamp: '2026-09-14T08:00:00.000Z' } };
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('event' in result);
  });

  test('generates a stable, deterministic requestId derived from the entry id (no Ring-supplied request_id exists for history entries)', () => {
    const result = normalizeRingHistoryEntry(motionEntry(), 'device-kitchen-01', 'house-1', 'ring_real');
    assert.ok('event' in result);
    if ('event' in result) {
      assert.match(result.event.requestId, /^history-device-kitchen-01-hist-evt-1$/);
    }
  });

  test('repeated normalization of the identical entry produces the identical eventId/requestId (idempotency-ready)', () => {
    const first = normalizeRingHistoryEntry(motionEntry(), 'device-1', 'house-1', 'ring_real');
    const second = normalizeRingHistoryEntry(motionEntry(), 'device-1', 'house-1', 'ring_real');
    assert.ok('event' in first && 'event' in second);
    if ('event' in first && 'event' in second) {
      assert.equal(first.event.eventId, second.event.eventId);
      assert.equal(first.event.requestId, second.event.requestId);
    }
  });
});

describe('ring/ringNormalizer: normalizeRingHistoryEntry — non-production / Playground-style kinds are rejected, never relabeled', () => {
  test('rejects a "on_demand" kind entry rather than treating it as a genuine motion event', () => {
    const entry = motionEntry({ kind: 'on_demand' });
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
    if ('error' in result) {
      assert.equal(result.error.nonProductionKind, 'on_demand');
      assert.match(result.error.reason, /not a documented production Ring Partner API value/);
    }
  });

  test('rejects a "ding" kind entry the same way', () => {
    const entry = motionEntry({ kind: 'ding' });
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
    if ('error' in result) {
      assert.equal(result.error.nonProductionKind, 'ding');
    }
  });

  test('rejects any other unrecognized kind value, not just the two known non-production ones', () => {
    const entry = motionEntry({ kind: 'something_completely_unexpected' });
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
    if ('error' in result) {
      assert.equal(result.error.nonProductionKind, 'something_completely_unexpected');
      assert.doesNotMatch(result.error.reason, /unrelated, unofficial third-party/); // only the KNOWN non-production kinds get that specific explanation
    }
  });

  test('never produces an accepted TendEvent for a rejected kind, even if other fields are perfectly well-formed', () => {
    const entry = motionEntry({ kind: 'on_demand' });
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.equal('event' in result, false);
  });
});

describe('ring/ringNormalizer: normalizeRingHistoryEntry — malformed input', () => {
  test('rejects an entry missing attributes.kind entirely', () => {
    const entry: RingRawHistoryEntry = { id: 'hist-1', attributes: { occurred_at: '2026-09-14T07:30:00.000Z' } };
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
  });

  test('rejects an entry missing an id', () => {
    const entry: RingRawHistoryEntry = { attributes: { kind: 'motion', occurred_at: '2026-09-14T07:30:00.000Z' } };
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
  });

  test('rejects an entry with no usable occurred-at timestamp under any of the checked field names', () => {
    const entry: RingRawHistoryEntry = { id: 'hist-1', attributes: { kind: 'motion' } };
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
  });

  test('rejects an entry with an unparseable occurred-at value', () => {
    const entry: RingRawHistoryEntry = { id: 'hist-1', attributes: { kind: 'motion', occurred_at: 'not-a-date' } };
    const result = normalizeRingHistoryEntry(entry, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
  });

  test('never throws on a completely malformed/null entry', () => {
    // @ts-expect-error deliberately passing null to prove this never throws
    const result = normalizeRingHistoryEntry(null, 'device-1', 'house-1', 'ring_real');
    assert.ok('error' in result);
  });
});
