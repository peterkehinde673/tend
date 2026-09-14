import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RingEventSource } from '../../src/ingestion/ring/ringEventSource';
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

const PLAYGROUND_CONFIG: RingConfig = { ...REAL_CONFIG, source: 'ring_playground' };

describe('ring/ringEventSource: EventSource interface conformance', () => {
  test('source and name reflect the configured provenance — ring_real', () => {
    const source = new RingEventSource(REAL_CONFIG);
    assert.equal(source.source, 'ring_real');
    assert.equal(source.name, 'ring-real');
  });

  test('source and name reflect the configured provenance — ring_playground', () => {
    const source = new RingEventSource(PLAYGROUND_CONFIG);
    assert.equal(source.source, 'ring_playground');
    assert.equal(source.name, 'ring-playground');
  });

  test('pull() honestly returns an empty array rather than fabricating events from device data', async () => {
    const source = new RingEventSource(REAL_CONFIG);
    const events = await source.pull();
    assert.deepEqual(events, []);
  });
});

describe('ring/ringEventSource: checkConnection (mocked fetch)', () => {
  test('reports ok:true on a successful current-user call', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'user-1' }), { status: 200 })) as FetchFn;
    const source = new RingEventSource(REAL_CONFIG);
    const result = await source.checkConnection();
    assert.deepEqual(result, { ok: true });
  });

  test('reports ok:false with a safe error message on failure, never including the token', async () => {
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as FetchFn;
    const source = new RingEventSource(REAL_CONFIG);
    const result = await source.checkConnection();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.includes(REAL_CONFIG.accessToken), false);
    }
  });
});

describe('ring/ringEventSource: discoverDevices (mocked fetch)', () => {
  test('returns defensively-summarized devices', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: 'device-1', attributes: { name: 'Front Door' } }]), { status: 200 })) as FetchFn;
    const source = new RingEventSource(REAL_CONFIG);
    const devices = await source.discoverDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, 'device-1');
    assert.equal(devices[0].label, 'Front Door');
  });

  test('propagates a clear error rather than silently returning [] on a network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('simulated network failure');
    }) as FetchFn;
    const source = new RingEventSource(REAL_CONFIG);
    await assert.rejects(() => source.discoverDevices());
  });
});

describe('ring/ringEventSource: pollMotionHistory — real polling path, kept separate from pull()', () => {
  test('pull() is completely unaffected by the existence of pollMotionHistory (preserves the existing webhook path)', async () => {
    const source = new RingEventSource(REAL_CONFIG);
    assert.deepEqual(await source.pull(), []);
  });

  test('splits accepted "motion" entries from rejected non-production entries', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'hist-1', attributes: { kind: 'motion', occurred_at: '2026-09-14T07:30:00.000Z', sub_type: 'human' } },
            { id: 'hist-2', attributes: { kind: 'on_demand', occurred_at: '2026-09-14T07:31:00.000Z' } },
          ],
        }),
        { status: 200 },
      )) as FetchFn;

    const source = new RingEventSource(REAL_CONFIG);
    const result = await source.pollMotionHistory('device-kitchen-01');

    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].eventType, 'motion_detected');
    assert.equal(result.accepted[0].source, 'ring_real');

    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason.nonProductionKind, 'on_demand');
  });

  test('throws immediately for a ring_playground-configured source, never attempting the call', async () => {
    let fetchWasCalled = false;
    globalThis.fetch = (async () => {
      fetchWasCalled = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as FetchFn;

    const source = new RingEventSource(PLAYGROUND_CONFIG);
    await assert.rejects(() => source.pollMotionHistory('device-1'), /only available for source "ring_real"/);
    assert.equal(fetchWasCalled, false, 'the Ring API should never be called when the source is not ring_real');
  });
});
