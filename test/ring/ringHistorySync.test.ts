import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncMotionHistoryToStore } from '../../src/ingestion/ring/ringHistorySync';
import { RingEventSource } from '../../src/ingestion/ring/ringEventSource';
import { InMemoryEventStore } from '../../src/store/inMemoryEventStore';
import { RingConfig } from '../../src/ingestion/ring/ringConfig';

type FetchFn = typeof fetch;
let originalFetch: FetchFn;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const REAL_CONFIG: RingConfig = {
  accessToken: 'fake-token',
  apiBaseUrl: 'https://ring-api.invalid-test-domain.example',
  source: 'ring_real',
  webhookHmacSecret: undefined,
};

function mockHistoryResponse(entries: unknown[]): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: entries }), { status: 200 })) as FetchFn;
}

describe('ring/ringHistorySync: syncMotionHistoryToStore', () => {
  test('persists accepted "motion" entries into the given EventStore', async () => {
    mockHistoryResponse([{ id: 'hist-1', attributes: { kind: 'motion', occurred_at: '2026-09-14T07:30:00.000Z', sub_type: 'human' } }]);

    const source = new RingEventSource(REAL_CONFIG);
    const store = new InMemoryEventStore();
    const result = await syncMotionHistoryToStore(source, store, 'device-kitchen-01');

    assert.equal(result.persisted.length, 1);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.rejected.length, 0);

    const stored = await store.getByHousehold(result.persisted[0].householdId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, 'ring_real');
  });

  test('re-syncing the identical history window is idempotent — no duplicate persisted events', async () => {
    mockHistoryResponse([{ id: 'hist-1', attributes: { kind: 'motion', occurred_at: '2026-09-14T07:30:00.000Z' } }]);
    const source = new RingEventSource(REAL_CONFIG);
    const store = new InMemoryEventStore();

    const first = await syncMotionHistoryToStore(source, store, 'device-1');
    const second = await syncMotionHistoryToStore(source, store, 'device-1');

    assert.equal(first.persisted.length, 1);
    assert.equal(second.persisted.length, 0);
    assert.equal(second.duplicates.length, 1);

    const stored = await store.getByHousehold(first.persisted[0].householdId);
    assert.equal(stored.length, 1, 'the store must not contain a duplicate after re-syncing the same window');
  });

  test('rejected (non-"motion") entries never reach the store', async () => {
    mockHistoryResponse([
      { id: 'hist-1', attributes: { kind: 'motion', occurred_at: '2026-09-14T07:30:00.000Z' } },
      { id: 'hist-2', attributes: { kind: 'on_demand', occurred_at: '2026-09-14T07:31:00.000Z' } },
    ]);
    const source = new RingEventSource(REAL_CONFIG);
    const store = new InMemoryEventStore();
    const result = await syncMotionHistoryToStore(source, store, 'device-1');

    assert.equal(result.persisted.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason.nonProductionKind, 'on_demand');

    const stored = await store.getByHousehold(result.persisted[0].householdId);
    assert.equal(stored.length, 1, 'only the accepted motion entry should ever be persisted');
  });

  test('inherits the ring_playground restriction unchanged — never even attempts the network call', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as FetchFn;

    const playgroundSource = new RingEventSource({ ...REAL_CONFIG, source: 'ring_playground' });
    const store = new InMemoryEventStore();

    await assert.rejects(() => syncMotionHistoryToStore(playgroundSource, store, 'device-1'), /only available for source "ring_real"/);
    assert.equal(fetchCalled, false);
  });
});
