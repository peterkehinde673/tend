import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoEventStore, DynamoModulesShape } from '../../src/store/dynamoEventStore';
import { TendEvent } from '../../src/domain/event';

/**
 * A self-contained, in-memory fake of the exact @aws-sdk/client-dynamodb +
 * @aws-sdk/lib-dynamodb surface DynamoEventStore uses, injected via the
 * constructor's moduleLoader parameter. This is NOT the real AWS SDK (it
 * cannot be installed in this environment — see dynamoEventStore.ts) —
 * it is a faithful-enough re-implementation of DynamoDB's Query/
 * TransactWriteItems semantics (conditional writes, KeyConditionExpression
 * begins_with/BETWEEN, FilterExpression, pagination, ScanIndexForward,
 * Limit) to genuinely exercise DynamoEventStore's own logic end to end.
 * Tests using this fake prove DynamoEventStore's behavior; they do not
 * prove anything about the real AWS API's actual behavior.
 */

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function buildFakeSdk(pageSize = 2): { sdk: DynamoModulesShape; table: Map<string, FakeItem> } {
  const table = new Map<string, FakeItem>();

  class FakeTransactWriteCommand {
    constructor(public input: { TransactItems: { Put: { TableName: string; Item: FakeItem; ConditionExpression: string } }[] }) {}
  }
  class FakeQueryCommand {
    constructor(
      public input: {
        KeyConditionExpression: string;
        FilterExpression?: string;
        ExpressionAttributeValues: Record<string, unknown>;
        ScanIndexForward?: boolean;
        Limit?: number;
        ExclusiveStartKey?: Record<string, unknown>;
      },
    ) {}
  }
  class FakeDynamoDBClient {
    constructor(public opts: { region: string }) {}
  }
  class FakeDynamoDBDocumentClient {
    static from(_client: unknown) {
      return {
        send: async (command: unknown) => {
          if (command instanceof FakeTransactWriteCommand) {
            const items = command.input.TransactItems;
            const keys = items.map((t) => `${t.Put.Item.pk}#${t.Put.Item.sk}`);
            const existingIndex = keys.findIndex((k) => table.has(k));
            if (existingIndex !== -1) {
              const err = new Error('TransactionCanceledException') as Error & { name: string; CancellationReasons: { Code: string }[] };
              err.name = 'TransactionCanceledException';
              err.CancellationReasons = items.map((_, i) => ({ Code: i === existingIndex ? 'ConditionalCheckFailed' : 'None' }));
              throw err;
            }
            for (const t of items) table.set(`${t.Put.Item.pk}#${t.Put.Item.sk}`, t.Put.Item);
            return {};
          }

          if (command instanceof FakeQueryCommand) {
            const { KeyConditionExpression, FilterExpression, ExpressionAttributeValues: vals, ScanIndexForward, Limit } = command.input;
            const pk = vals[':pk'] as string;

            let matches = [...table.values()].filter((item) => item.pk === pk);

            if (KeyConditionExpression.includes('begins_with(sk')) {
              const prefix = vals[':prefix'] as string;
              matches = matches.filter((item) => item.sk.startsWith(prefix));
            } else if (KeyConditionExpression.includes('BETWEEN')) {
              const from = vals[':from'] as string;
              const to = vals[':to'] as string;
              matches = matches.filter((item) => item.sk >= from && item.sk <= to);
            }

            if (FilterExpression?.includes('occurredAt < :toIso')) {
              const toIso = vals[':toIso'] as string;
              matches = matches.filter((item) => (item.occurredAt as string) < toIso);
            }
            if (FilterExpression?.includes('deviceId = :deviceId')) {
              const deviceId = vals[':deviceId'] as string;
              matches = matches.filter((item) => item.deviceId === deviceId);
            }

            matches.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
            if (ScanIndexForward === false) matches.reverse();

            // Simulate pagination: page through `pageSize` items at a time
            // regardless of the caller's own Limit, unless Limit is smaller.
            const startIndex = command.input.ExclusiveStartKey ? Number((command.input.ExclusiveStartKey as { _index: number })._index) : 0;
            const effectivePageSize = Limit !== undefined ? Math.min(Limit, pageSize) : pageSize;
            const page = matches.slice(startIndex, startIndex + effectivePageSize);
            const nextIndex = startIndex + effectivePageSize;
            const hasMore = Limit === undefined && nextIndex < matches.length;

            return {
              Items: page,
              LastEvaluatedKey: hasMore ? { _index: nextIndex } : undefined,
            };
          }

          throw new Error('Unrecognized fake command');
        },
      };
    }
  }

  const sdk: DynamoModulesShape = {
    DynamoDBClient: FakeDynamoDBClient as unknown as DynamoModulesShape['DynamoDBClient'],
    DynamoDBDocumentClient: FakeDynamoDBDocumentClient as unknown as DynamoModulesShape['DynamoDBDocumentClient'],
    QueryCommand: FakeQueryCommand as unknown as DynamoModulesShape['QueryCommand'],
    TransactWriteCommand: FakeTransactWriteCommand as unknown as DynamoModulesShape['TransactWriteCommand'],
  };

  return { sdk, table };
}

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

describe('store/dynamoEventStore: mocked CRUD behavior (fake SDK, not live AWS)', () => {
  test('append() persists a new event and it round-trips byte-identically through getByHousehold (serialization)', async () => {
    const { sdk } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    const event = makeEvent();

    const result = await store.append(event);
    assert.equal(result.accepted, true);

    const stored = await store.getByHousehold('house-1');
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0], event, 'the round-tripped event must be identical to what was appended');
  });

  test('append() rejects a duplicate eventId with the correct specific reason', async () => {
    const { sdk } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-1' }));
    const second = await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-2' }));

    assert.equal(second.accepted, false);
    assert.match(second.reason ?? '', /Duplicate eventId/);

    const stored = await store.getByHousehold('house-1');
    assert.equal(stored.length, 1, 'the duplicate must not create a second item');
  });

  test('append() rejects a duplicate requestId (replay) with the correct specific reason', async () => {
    const { sdk } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-1' }));
    const second = await store.append(makeEvent({ eventId: 'evt-2', requestId: 'req-1' }));

    assert.equal(second.accepted, false);
    assert.match(second.reason ?? '', /replay/);

    const stored = await store.getByHousehold('house-1');
    assert.equal(stored.length, 1);
  });

  test('append() never persists a partial write when the transaction is cancelled (atomicity)', async () => {
    const { sdk, table } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-1' }));
    await store.append(makeEvent({ eventId: 'evt-1', requestId: 'req-2' })); // rejected

    // Only the 3 items from the FIRST successful append should exist:
    // 1 event item + 2 idempotency markers. The second, rejected attempt
    // must not have left behind a stray idempotency marker for req-2.
    assert.equal(table.size, 3);
  });

  test('append() never writes anything beyond the normalized TendEvent fields plus pk/sk (data minimization)', async () => {
    const { sdk, table } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    await store.append(makeEvent());

    const eventItem = [...table.values()].find((item) => item.sk.startsWith('EVENT#'));
    assert.ok(eventItem);
    const allowedKeys = new Set([
      'pk',
      'sk',
      'householdId',
      'deviceId',
      'componentId',
      'eventId',
      'requestId',
      'eventType',
      'subType',
      'zoneId',
      'occurredAt',
      'ingestedAt',
      'source',
      'rawEventId',
    ]);
    for (const key of Object.keys(eventItem!)) {
      assert.ok(allowedKeys.has(key), `unexpected field persisted: ${key} — this would violate data minimization`);
    }
  });

  test('getByTimeRange respects the exclusive upper bound', async () => {
    const { sdk } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    await store.append(makeEvent({ eventId: 'e1', requestId: 'r1', occurredAt: '2026-09-14T07:00:00.000Z' }));
    await store.append(makeEvent({ eventId: 'e2', requestId: 'r2', occurredAt: '2026-09-14T08:00:00.000Z' }));

    const result = await store.getByTimeRange({ householdId: 'house-1', fromIso: '2026-09-14T00:00:00.000Z', toIso: '2026-09-14T08:00:00.000Z' });
    assert.equal(result.length, 1);
    assert.equal(result[0].eventId, 'e1');
  });

  test('getByTimeRange filters by deviceId when provided', async () => {
    const { sdk } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    await store.append(makeEvent({ eventId: 'e1', requestId: 'r1', deviceId: 'device-a', occurredAt: '2026-09-14T07:00:00.000Z' }));
    await store.append(makeEvent({ eventId: 'e2', requestId: 'r2', deviceId: 'device-b', occurredAt: '2026-09-14T07:10:00.000Z' }));

    const result = await store.getByTimeRange({
      householdId: 'house-1',
      fromIso: '2026-09-14T00:00:00.000Z',
      toIso: '2026-09-14T09:00:00.000Z',
      deviceId: 'device-a',
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].deviceId, 'device-a');
  });

  test('getRecent returns the most recent N events in ascending order (matching InMemoryEventStore convention)', async () => {
    const { sdk } = buildFakeSdk(10); // large page size so pagination doesn't interfere with this specific assertion
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    for (let i = 0; i < 5; i++) {
      await store.append(makeEvent({ eventId: `e${i}`, requestId: `r${i}`, occurredAt: `2026-09-14T0${i}:00:00.000Z` }));
    }

    const recent = await store.getRecent('house-1', 2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].eventId, 'e3');
    assert.equal(recent[1].eventId, 'e4', 'most recent must be last, matching InMemoryEventStore');
  });

  test('getByHousehold paginates across multiple pages and returns every item, sorted chronologically', async () => {
    const { sdk } = buildFakeSdk(2); // small page size forces the pagination loop to run multiple times
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    for (let i = 0; i < 5; i++) {
      await store.append(makeEvent({ eventId: `e${i}`, requestId: `r${i}`, occurredAt: `2026-09-14T0${i}:00:00.000Z` }));
    }

    const all = await store.getByHousehold('house-1');
    assert.equal(all.length, 5);
    assert.deepEqual(
      all.map((e) => e.eventId),
      ['e0', 'e1', 'e2', 'e3', 'e4'],
    );
  });

  test('getByDevice paginates and filters correctly across multiple pages', async () => {
    const { sdk } = buildFakeSdk(1); // force pagination on every item
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    await store.append(makeEvent({ eventId: 'e1', requestId: 'r1', deviceId: 'device-a', occurredAt: '2026-09-14T07:00:00.000Z' }));
    await store.append(makeEvent({ eventId: 'e2', requestId: 'r2', deviceId: 'device-b', occurredAt: '2026-09-14T07:10:00.000Z' }));
    await store.append(makeEvent({ eventId: 'e3', requestId: 'r3', deviceId: 'device-a', occurredAt: '2026-09-14T07:20:00.000Z' }));

    const result = await store.getByDevice('house-1', 'device-a');
    assert.equal(result.length, 2);
    assert.ok(result.every((e) => e.deviceId === 'device-a'));
  });

  test('idempotency is scoped per household, matching InMemoryEventStore', async () => {
    const { sdk } = buildFakeSdk();
    const store = new DynamoEventStore({ region: 'us-east-1', tableName: 't' }, async () => sdk);
    const r1 = await store.append(makeEvent({ householdId: 'house-1', eventId: 'evt-1', requestId: 'req-1' }));
    const r2 = await store.append(makeEvent({ householdId: 'house-2', eventId: 'evt-1', requestId: 'req-1' }));
    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, true);
  });
});
