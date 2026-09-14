import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RingApiClient, RingApiError } from '../../src/ingestion/ring/ringClient';
import { RingConfig } from '../../src/ingestion/ring/ringConfig';

/**
 * IMPORTANT: every test in this file uses a MOCKED global `fetch`. None of
 * these tests make a real network call, and none of them prove anything
 * about Ring's actual live API — they prove RingApiClient's own request
 * construction, response handling, and error handling logic in isolation.
 * See test/ring/ringLiveCheck.md (referenced from the README) and the
 * Phase 2 status report for what live-network verification actually showed
 * in this sandboxed environment (outbound calls to Ring's API domains are
 * blocked by the egress proxy — see ringCheck.ts).
 */

const FAKE_CONFIG: RingConfig = {
  accessToken: 'fake-test-token-value',
  apiBaseUrl: 'https://ring-api.invalid-test-domain.example',
  source: 'ring_real',
  webhookHmacSecret: undefined,
};

type FetchFn = typeof fetch;
let originalFetch: FetchFn;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOnce(handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    return handler(String(input), init);
  }) as FetchFn;
}

describe('ring/ringClient: RingApiClient — authenticatedGet (mocked fetch, no real network)', () => {
  test('sends a Bearer Authorization header built from the configured token', async () => {
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as FetchFn;

    const client = new RingApiClient(FAKE_CONFIG);
    await client.authenticatedGet('/v1/users/me');

    assert.equal(capturedAuth, `Bearer ${FAKE_CONFIG.accessToken}`);
  });

  test('returns parsed JSON on a 200 response', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    const result = await client.authenticatedGet('/v1/users/me');
    assert.deepEqual(result, { hello: 'world' });
  });

  test('throws RingApiError on a non-2xx response, with the status code attached', async () => {
    mockFetchOnce(() => new Response('unauthorized', { status: 401 }));
    const client = new RingApiClient(FAKE_CONFIG);
    await assert.rejects(
      () => client.authenticatedGet('/v1/users/me'),
      (err: unknown) => err instanceof RingApiError && err.status === 401,
    );
  });

  test('throws RingApiError on a network failure, never including the token in the message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND ring-api.invalid-test-domain.example');
    }) as FetchFn;
    const client = new RingApiClient(FAKE_CONFIG);
    await assert.rejects(
      () => client.authenticatedGet('/v1/users/me'),
      (err: unknown) => {
        assert.ok(err instanceof RingApiError);
        assert.equal((err as RingApiError).message.includes(FAKE_CONFIG.accessToken), false);
        return true;
      },
    );
  });

  test('throws RingApiError when the response body is not valid JSON', async () => {
    mockFetchOnce(() => new Response('not json', { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    await assert.rejects(() => client.authenticatedGet('/v1/users/me'), RingApiError);
  });
});

describe('ring/ringClient: RingApiClient — listDevices defensive parsing (mocked fetch)', () => {
  test('handles a bare array response', async () => {
    mockFetchOnce(() => new Response(JSON.stringify([{ id: 'device-1' }, { id: 'device-2' }]), { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    const devices = await client.listDevices();
    assert.equal(devices.length, 2);
  });

  test('handles a JSON:API-style { data: [...] } response', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ data: [{ id: 'device-1' }] }), { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    const devices = await client.listDevices();
    assert.equal(devices.length, 1);
  });

  test('returns an empty array rather than throwing for an unrecognized shape', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ somethingElse: true }), { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    const devices = await client.listDevices();
    assert.deepEqual(devices, []);
  });
});

describe('ring/ringClient: RingApiClient — secret handling', () => {
  test('never includes the access token in a thrown error message, even on repeated failures', async () => {
    mockFetchOnce(() => new Response('forbidden', { status: 403 }));
    const client = new RingApiClient(FAKE_CONFIG);
    try {
      await client.authenticatedGet('/v1/devices');
      assert.fail('expected authenticatedGet to throw');
    } catch (err) {
      const message = (err as Error).message;
      assert.equal(message.includes(FAKE_CONFIG.accessToken), false);
      assert.match(message, /redacted/);
    }
  });
});

describe('ring/ringClient: RingApiClient — getEventHistory (mocked fetch)', () => {
  test('constructs the expected best-effort URL with event_types=motion', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as FetchFn;

    const client = new RingApiClient(FAKE_CONFIG);
    await client.getEventHistory('device-kitchen-01');

    assert.equal(capturedUrl, `${FAKE_CONFIG.apiBaseUrl}/v1/devices/device-kitchen-01/history?event_types=motion`);
  });

  test('supports requesting multiple event types as a comma-separated list', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as FetchFn;

    const client = new RingApiClient(FAKE_CONFIG);
    await client.getEventHistory('device-1', ['motion', 'on_demand']);

    assert.equal(capturedUrl, `${FAKE_CONFIG.apiBaseUrl}/v1/devices/device-1/history?event_types=motion,on_demand`);
  });

  test('URL-encodes a device id containing special characters', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as FetchFn;

    const client = new RingApiClient(FAKE_CONFIG);
    await client.getEventHistory('device with spaces/slash');

    assert.ok(capturedUrl?.includes(encodeURIComponent('device with spaces/slash')));
  });

  test('handles a JSON:API-style { data: [...] } response', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ data: [{ id: 'hist-1', attributes: { kind: 'motion' } }] }), { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    const entries = await client.getEventHistory('device-1');
    assert.equal(entries.length, 1);
  });

  test('handles a bare array response', async () => {
    mockFetchOnce(() => new Response(JSON.stringify([{ id: 'hist-1' }]), { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    const entries = await client.getEventHistory('device-1');
    assert.equal(entries.length, 1);
  });

  test('returns an empty array rather than throwing for an unrecognized shape', async () => {
    mockFetchOnce(() => new Response(JSON.stringify({ somethingElse: true }), { status: 200 }));
    const client = new RingApiClient(FAKE_CONFIG);
    const entries = await client.getEventHistory('device-1');
    assert.deepEqual(entries, []);
  });
});
