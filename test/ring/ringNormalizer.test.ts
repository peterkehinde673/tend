import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRingWebhookEvent, summarizeRingDevice } from '../../src/ingestion/ring/ringNormalizer';
import { RingWebhookEnvelope } from '../../src/ingestion/ring/ringTypes';
import { validateTendEvent } from '../../src/domain/event';

function validEnvelope(overrides: Partial<RingWebhookEnvelope> = {}): RingWebhookEnvelope {
  return {
    meta: {
      version: '1.1',
      time: '2026-09-14T07:30:00.000Z',
      request_id: 'req-abc-123',
      account_id: 'acct-xyz',
    },
    data: {
      id: 'evt-abc-123',
      type: 'motion_detected',
      subType: 'human',
      attributes: {
        source: 'device-kitchen-01',
        source_type: 'devices',
      },
    },
    ...overrides,
  };
}

describe('ring/ringNormalizer: normalizeRingWebhookEvent — valid cases', () => {
  test('normalizes a well-formed motion_detected envelope into a schema-valid TendEvent', () => {
    const result = normalizeRingWebhookEvent(validEnvelope(), 'house-1', 'ring_real', '2026-09-14T07:30:01.000Z');
    assert.ok('event' in result, `expected success, got: ${JSON.stringify(result)}`);
    if ('event' in result) {
      assert.equal(result.event.householdId, 'house-1');
      assert.equal(result.event.deviceId, 'device-kitchen-01');
      assert.equal(result.event.eventId, 'evt-abc-123');
      assert.equal(result.event.requestId, 'req-abc-123');
      assert.equal(result.event.eventType, 'motion_detected');
      assert.equal(result.event.subType, 'human');
      assert.equal(result.event.source, 'ring_real');
      assert.equal(result.event.occurredAt, '2026-09-14T07:30:00.000Z');
      assert.deepEqual(validateTendEvent(result.event), []);
    }
  });

  test('correctly labels source as ring_playground when passed that source', () => {
    const result = normalizeRingWebhookEvent(validEnvelope(), 'house-1', 'ring_playground');
    assert.ok('event' in result);
    if ('event' in result) {
      assert.equal(result.event.source, 'ring_playground');
    }
  });

  test('maps an unrecognized motion subType to other_motion rather than passing it through unvalidated', () => {
    const envelope = validEnvelope({ data: { ...validEnvelope().data, subType: 'some_future_ring_classification' } });
    const result = normalizeRingWebhookEvent(envelope, 'house-1', 'ring_real');
    assert.ok('event' in result);
    if ('event' in result) {
      assert.equal(result.event.subType, 'other_motion');
    }
  });

  test('extracts componentId only when component_ids is present and non-empty', () => {
    const envelope = validEnvelope({
      data: { ...validEnvelope().data, attributes: { source: 'device-elite-01', source_type: 'devices', component_ids: ['cam-2', 'cam-3'] } },
    });
    const result = normalizeRingWebhookEvent(envelope, 'house-1', 'ring_real');
    assert.ok('event' in result);
    if ('event' in result) {
      assert.equal(result.event.componentId, 'cam-2');
    }
  });

  test('button_press events normalize without a subType', () => {
    const envelope = validEnvelope({ data: { id: 'evt-btn-1', type: 'button_press', attributes: { source: 'device-doorbell-01', source_type: 'devices' } } });
    const result = normalizeRingWebhookEvent(envelope, 'house-1', 'ring_real');
    assert.ok('event' in result);
    if ('event' in result) {
      assert.equal(result.event.eventType, 'button_press');
      assert.equal(result.event.subType, undefined);
    }
  });
});

describe('ring/ringNormalizer: normalizeRingWebhookEvent — malformed/unsupported input', () => {
  test('rejects a completely malformed envelope missing meta/data', () => {
    const result = normalizeRingWebhookEvent({} as RingWebhookEnvelope, 'house-1', 'ring_real');
    assert.ok('error' in result);
  });

  test('rejects an unsupported event type', () => {
    const envelope = validEnvelope({ data: { ...validEnvelope().data, type: 'some_unknown_event' as never } });
    const result = normalizeRingWebhookEvent(envelope, 'house-1', 'ring_real');
    assert.ok('error' in result);
    if ('error' in result) {
      assert.match(result.error.reason, /Unsupported/);
    }
  });

  test('rejects an envelope missing attributes.source', () => {
    const envelope = validEnvelope({ data: { ...validEnvelope().data, attributes: { source: '', source_type: 'devices' } } });
    const result = normalizeRingWebhookEvent(envelope, 'house-1', 'ring_real');
    assert.ok('error' in result);
  });

  test('rejects an envelope missing request_id', () => {
    const envelope = validEnvelope({ meta: { ...validEnvelope().meta, request_id: '' } });
    const result = normalizeRingWebhookEvent(envelope, 'house-1', 'ring_real');
    assert.ok('error' in result);
  });

  test('rejects an envelope with an invalid meta.time', () => {
    const envelope = validEnvelope({ meta: { ...validEnvelope().meta, time: 'not-a-timestamp' } });
    const result = normalizeRingWebhookEvent(envelope, 'house-1', 'ring_real');
    assert.ok('error' in result);
  });
});

describe('ring/ringNormalizer: summarizeRingDevice — defensive, unconfirmed-shape handling', () => {
  test('extracts id and label when present in the expected shape', () => {
    const summary = summarizeRingDevice({ id: 'device-1', attributes: { name: 'Front Door' } });
    assert.deepEqual(summary, { id: 'device-1', label: 'Front Door', unparsed: false });
  });

  test('falls back to type when attributes.name is absent', () => {
    const summary = summarizeRingDevice({ id: 'device-1', type: 'doorbell' });
    assert.deepEqual(summary, { id: 'device-1', label: 'doorbell', unparsed: false });
  });

  test('marks an entry unparsed rather than throwing when nothing recognizable is present', () => {
    const summary = summarizeRingDevice({ someUnexpectedField: 123 });
    assert.equal(summary.unparsed, true);
  });

  test('never throws on a completely malformed entry', () => {
    // @ts-expect-error deliberately passing a non-object to prove this never throws
    const summary = summarizeRingDevice(null);
    assert.equal(summary.unparsed, true);
  });
});
