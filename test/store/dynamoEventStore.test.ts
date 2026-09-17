import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eventSortKey, householdPartitionKey, idempEventSortKey, idempRequestSortKey, DynamoEventStore, DynamoOperationError } from '../../src/store/dynamoEventStore';
import { TendEvent } from '../../src/domain/event';

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

describe('store/dynamoEventStore: key construction helpers', () => {
  test('householdPartitionKey scopes every key to one household', () => {
    assert.equal(householdPartitionKey('house-1'), 'HOUSEHOLD#house-1');
    assert.notEqual(householdPartitionKey('house-1'), householdPartitionKey('house-2'));
  });

  test('eventSortKey sorts chronologically as a plain string comparison (ISO 8601 property)', () => {
    const earlier = eventSortKey('2026-09-14T07:00:00.000Z', 'evt-a');
    const later = eventSortKey('2026-09-14T08:00:00.000Z', 'evt-b');
    assert.ok(earlier < later, 'lexicographic string comparison of ISO timestamps must match chronological order');
  });

  test('eventSortKey uses eventId as a tiebreaker for identical timestamps', () => {
    const a = eventSortKey('2026-09-14T07:00:00.000Z', 'evt-a');
    const b = eventSortKey('2026-09-14T07:00:00.000Z', 'evt-b');
    assert.notEqual(a, b);
    assert.ok(a < b);
  });

  test('idempEventSortKey and idempRequestSortKey are namespaced distinctly from each other and from event keys', () => {
    const eventId = 'shared-id';
    const requestId = 'shared-id';
    const idempEvent = idempEventSortKey(eventId);
    const idempRequest = idempRequestSortKey(requestId);
    const eventKey = eventSortKey('2026-09-14T07:00:00.000Z', eventId);

    assert.notEqual(idempEvent, idempRequest);
    assert.notEqual(idempEvent, eventKey);
    assert.notEqual(idempRequest, eventKey);
  });

  test('key helpers never include anything beyond the ids/timestamps supplied (no accidental payload leakage)', () => {
    const event = makeEvent();
    const sk = eventSortKey(event.occurredAt, event.eventId);
    assert.equal(sk, `EVENT#${event.occurredAt}#${event.eventId}`);
    assert.equal(sk.includes(event.deviceId), false);
  });
});

describe('store/dynamoEventStore: SDK-load failure path', () => {
  const failingLoader = async () => {
    throw new Error('simulated missing package');
  };

  test('append() throws a clear DynamoOperationError when the SDK loader fails', async () => {
    const store = new DynamoEventStore(
      { region: 'us-east-1', tableName: 'fake-table' },
      failingLoader,
    );
    await assert.rejects(
      () => store.append(makeEvent()),
      (err: unknown) => {
        assert.ok(err instanceof DynamoOperationError);
        assert.match((err as Error).message, /simulated missing package/);
        assert.match((err as Error).message, /DynamoDB append failed for household house-1/);
        return true;
      },
    );
  });

  test('getByHousehold() also fails honestly rather than silently returning an empty array', async () => {
    const store = new DynamoEventStore(
      { region: 'us-east-1', tableName: 'fake-table' },
      failingLoader,
    );
    await assert.rejects(
      () => store.getByHousehold('house-1'),
      (err: unknown) => err instanceof DynamoOperationError,
    );
  });

  test('the SDK-load error never includes credentials or other sensitive values', async () => {
    const store = new DynamoEventStore(
      { region: 'us-east-1', tableName: 'fake-table' },
      failingLoader,
    );
    try {
      await store.append(makeEvent());
      assert.fail('expected append() to throw');
    } catch (err) {
      const message = (err as Error).message;
      assert.equal(/AKIA[0-9A-Z]{16}/.test(message), false);
      assert.equal(message.toLowerCase().includes('secret'), false);
    }
  });
});
