import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { handleRingWebhook, isWithinReplayTolerance, verifyRingSignature } from '../../src/ingestion/ring/ringWebhookHandler';
import { InMemoryEventStore } from '../../src/store/inMemoryEventStore';
import { RingWebhookEnvelope } from '../../src/ingestion/ring/ringTypes';

const SECRET = 'test-hmac-secret-value';

function sign(body: string, secret: string = SECRET): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function validBody(overrides: Partial<RingWebhookEnvelope> = {}, now: Date = new Date('2026-09-14T07:30:05.000Z')): string {
  const envelope: RingWebhookEnvelope = {
    meta: {
      version: '1.1',
      time: now.toISOString(),
      request_id: 'req-abc-1',
      account_id: 'acct-1',
    },
    data: {
      id: 'evt-abc-1',
      type: 'motion_detected',
      subType: 'human',
      attributes: { source: 'device-kitchen-01', source_type: 'devices' },
    },
    ...overrides,
  };
  return JSON.stringify(envelope);
}

describe('ring/ringWebhookHandler: verifyRingSignature', () => {
  test('accepts a correctly signed body', () => {
    const body = validBody();
    assert.equal(verifyRingSignature(body, sign(body), SECRET), true);
  });

  test('rejects a body with a tampered signature', () => {
    const body = validBody();
    assert.equal(verifyRingSignature(body, sign(body) + 'ff', SECRET), false);
  });

  test('rejects when the signature was computed with a different secret', () => {
    const body = validBody();
    assert.equal(verifyRingSignature(body, sign(body, 'wrong-secret'), SECRET), false);
  });

  test('rejects when the body was tampered with after signing', () => {
    const body = validBody();
    const signature = sign(body);
    const tamperedBody = body.replace('device-kitchen-01', 'device-bedroom-01');
    assert.equal(verifyRingSignature(tamperedBody, signature, SECRET), false);
  });

  test('rejects when no signature header is present', () => {
    assert.equal(verifyRingSignature(validBody(), undefined, SECRET), false);
  });

  test('does not throw on a signature of a completely different length', () => {
    assert.doesNotThrow(() => verifyRingSignature(validBody(), 'short', SECRET));
    assert.equal(verifyRingSignature(validBody(), 'short', SECRET), false);
  });
});

describe('ring/ringWebhookHandler: isWithinReplayTolerance', () => {
  test('accepts a timestamp within tolerance', () => {
    const now = new Date('2026-09-14T07:30:05.000Z');
    assert.equal(isWithinReplayTolerance('2026-09-14T07:29:00.000Z', now), true);
  });

  test('rejects a timestamp far in the past', () => {
    const now = new Date('2026-09-14T07:30:05.000Z');
    assert.equal(isWithinReplayTolerance('2026-09-14T06:00:00.000Z', now), false);
  });

  test('rejects a timestamp far in the future', () => {
    const now = new Date('2026-09-14T07:30:05.000Z');
    assert.equal(isWithinReplayTolerance('2026-09-14T09:00:00.000Z', now), false);
  });

  test('rejects an unparseable timestamp', () => {
    assert.equal(isWithinReplayTolerance('not-a-date'), false);
  });
});

describe('ring/ringWebhookHandler: handleRingWebhook — end to end', () => {
  const NOW = new Date('2026-09-14T07:30:05.000Z');

  test('accepts a validly signed, well-formed, fresh event and stores it', async () => {
    const store = new InMemoryEventStore();
    const body = validBody({}, NOW);
    const result = await handleRingWebhook(body, sign(body), store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: SECRET,
      now: NOW,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, true);

    const stored = await store.getByHousehold('house-1');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, 'ring_real');
  });

  test('returns 501 when no HMAC secret is configured, and stores nothing', async () => {
    const store = new InMemoryEventStore();
    const body = validBody({}, NOW);
    const result = await handleRingWebhook(body, sign(body), store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: undefined,
      now: NOW,
    });
    assert.equal(result.status, 501);
    assert.equal(result.body.accepted, false);
    assert.equal((await store.getByHousehold('house-1')).length, 0);
  });

  test('returns 401 for an invalid signature, and stores nothing', async () => {
    const store = new InMemoryEventStore();
    const body = validBody({}, NOW);
    const result = await handleRingWebhook(body, 'totally-wrong-signature-value', store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: SECRET,
      now: NOW,
    });
    assert.equal(result.status, 401);
    assert.equal((await store.getByHousehold('house-1')).length, 0);
  });

  test('returns 400 for malformed (non-JSON) body', async () => {
    const store = new InMemoryEventStore();
    const body = 'not valid json {{{';
    const result = await handleRingWebhook(body, sign(body), store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: SECRET,
      now: NOW,
    });
    assert.equal(result.status, 400);
  });

  test('returns 400 for a stale timestamp outside replay tolerance, even with a valid signature', async () => {
    const store = new InMemoryEventStore();
    const staleTime = new Date('2026-09-14T00:00:00.000Z'); // hours before NOW
    const body = validBody({}, staleTime);
    const result = await handleRingWebhook(body, sign(body), store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: SECRET,
      now: NOW,
    });
    assert.equal(result.status, 400);
    assert.equal((await store.getByHousehold('house-1')).length, 0);
  });

  test('returns 400 for an unsupported/malformed event schema', async () => {
    const store = new InMemoryEventStore();
    const body = validBody({ data: { id: 'evt-2', type: 'motion_detected', attributes: { source: '', source_type: 'devices' } } }, NOW);
    const result = await handleRingWebhook(body, sign(body), store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: SECRET,
      now: NOW,
    });
    assert.equal(result.status, 400);
  });

  test('idempotency: replaying the exact same valid event is acknowledged with 200 but not stored twice', async () => {
    const store = new InMemoryEventStore();
    const body = validBody({}, NOW);
    const first = await handleRingWebhook(body, sign(body), store, { householdId: 'house-1', source: 'ring_real', hmacSecret: SECRET, now: NOW });
    const second = await handleRingWebhook(body, sign(body), store, { householdId: 'house-1', source: 'ring_real', hmacSecret: SECRET, now: NOW });

    assert.equal(first.status, 200);
    assert.equal(first.body.accepted, true);
    assert.equal(second.status, 200);
    assert.equal(second.body.accepted, false); // acknowledged, but flagged as a duplicate, not stored again
    assert.equal((await store.getByHousehold('house-1')).length, 1);
  });

  test('rejects an oversized request body', async () => {
    const store = new InMemoryEventStore();
    const hugeBody = JSON.stringify({ padding: 'x'.repeat(100_000) });
    const result = await handleRingWebhook(hugeBody, sign(hugeBody), store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: SECRET,
      now: NOW,
    });
    assert.equal(result.status, 413);
  });

  test('never includes the HMAC secret or signature in any response body', async () => {
    const store = new InMemoryEventStore();
    const body = validBody({}, NOW);
    const result = await handleRingWebhook(body, 'wrong-signature', store, {
      householdId: 'house-1',
      source: 'ring_real',
      hmacSecret: SECRET,
      now: NOW,
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes('wrong-signature'), false);
  });
});
