import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore } from '../src/store/inMemoryEventStore';
import { TendEvent } from '../src/domain/event';

function makeEvent(overrides: Partial<TendEvent> = {}): TendEvent {
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

describe('store/InMemoryEventStore: idempotency', () => {
  test('first event is accepted', async () => {
    const store = new InMemoryEventStore();
    const result = await store.append(makeEvent());
    assert.equal(result.accepted, true);
    const all = await store.getByHousehold('house-1');
    assert.equal(all.length, 1);
  });

  test('duplicate eventId is rejected even with a different requestId', async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-1' }));
    const result = await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-2' }));
    assert.equal(result.accepted, false);
    assert.match(result.reason ?? '', /Duplicate eventId/);
    const all = await store.getByHousehold('house-1');
    assert.equal(all.length, 1);
  });

  test('same requestId replay is rejected even with a different eventId', async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-1' }));
    const result = await store.append(makeEvent({ eventId: 'evt-2', requestId: 'req-1' }));
    assert.equal(result.accepted, false);
    assert.match(result.reason ?? '', /replay/);
    const all = await store.getByHousehold('house-1');
    assert.equal(all.length, 1);
  });

  test('genuinely different events (distinct eventId and requestId) are both accepted', async () => {
    const store = new InMemoryEventStore();
    const r1 = await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-1' }));
    const r2 = await store.append(makeEvent({ eventId: 'evt-2', requestId: 'req-2', occurredAt: '2026-09-14T07:42:00.000Z' }));
    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, true);
    const all = await store.getByHousehold('house-1');
    assert.equal(all.length, 2);
  });

  test('idempotency is scoped per household (same eventId in a different household is fine)', async () => {
    const store = new InMemoryEventStore();
    const r1 = await store.append(makeEvent({ householdId: 'house-1', eventId: 'evt-1' }));
    const r2 = await store.append(makeEvent({ householdId: 'house-2', eventId: 'evt-1' }));
    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, true);
  });

  test('getByTimeRange filters correctly by time and optional deviceId', async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-1', occurredAt: '2026-09-14T07:30:00.000Z', deviceId: 'device-kitchen-01' }));
    await store.append(makeEvent({ eventId: 'evt-2', requestId: 'req-2', occurredAt: '2026-09-14T08:30:00.000Z', deviceId: 'device-bedroom-01' }));

    const inRange = await store.getByTimeRange({
      householdId: 'house-1',
      fromIso: '2026-09-14T00:00:00.000Z',
      toIso: '2026-09-14T08:00:00.000Z',
    });
    assert.equal(inRange.length, 1);
    assert.equal(inRange[0].eventId, 'evt-1');

    const byDevice = await store.getByTimeRange({
      householdId: 'house-1',
      fromIso: '2026-09-14T00:00:00.000Z',
      toIso: '2026-09-15T00:00:00.000Z',
      deviceId: 'device-bedroom-01',
    });
    assert.equal(byDevice.length, 1);
    assert.equal(byDevice[0].eventId, 'evt-2');
  });

  test('getRecent returns at most `limit` events, most recent last', async () => {
    const store = new InMemoryEventStore();
    for (let i = 0; i < 5; i++) {
      await store.append(
        makeEvent({ eventId: `evt-${i}`, requestId: `req-${i}`, occurredAt: `2026-09-14T0${i}:00:00.000Z` }),
      );
    }
    const recent = await store.getRecent('house-1', 2);
    assert.equal(recent.length, 2);
    assert.equal(recent[recent.length - 1].eventId, 'evt-4');
  });
});
