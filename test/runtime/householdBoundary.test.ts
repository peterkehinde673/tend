import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { handler } from '../../src/runtime/lambdaHandler';

function signed(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

test('feedback rejects a payload for a different household', async () => {
  process.env.RING_WEBHOOK_HMAC_SECRET = 'boundary-test-secret';
  process.env.RING_HOUSEHOLD_ID = 'household-a';
  const body = JSON.stringify({
    householdId: 'household-b',
    deviationId: 'dev-1',
    feedbackType: 'expected',
    affectedSignals: ['presence'],
    timestamp: '2026-09-17T10:00:00.000Z',
  });

  const result = await handler({
    requestContext: { http: { method: 'POST', path: '/feedback' } },
    body,
    headers: { 'x-signature': signed(body, 'boundary-test-secret') },
  });

  assert.ok('statusCode' in result);
  assert.equal(result.statusCode, 403);
});

test('scheduled analysis ignores an unconfigured household and rejects mismatch', async () => {
  process.env.RING_HOUSEHOLD_ID = 'household-a';
  await assert.rejects(
    () => handler({ source: 'tend.scheduler', detail: { householdId: 'household-b' } }),
    /household does not match/,
  );
});
