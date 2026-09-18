import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../../src/runtime/lambdaHandler';

describe('runtime/lambdaHandler', () => {
  test('returns 404 for unsupported HTTP routes', async () => {
    const result = await handler({
      requestContext: { http: { method: 'GET', path: '/unsupported' } },
    });

    assert.equal(result.statusCode, 404);
    assert.deepEqual(JSON.parse(result.body), { error: 'Not found' });
  });

  test('returns health status for the runtime health endpoint', async () => {
    const result = await handler({
      requestContext: { http: { method: 'GET', path: '/health' } },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      status: 'ok',
      service: 'tend-runtime',
      eventStore: process.env.EVENT_STORE ?? 'in_memory',
    });
  });

  test('returns the existing safe-deny webhook response when HMAC configuration is absent', async () => {
    const previousSecret = process.env.RING_WEBHOOK_HMAC_SECRET;
    delete process.env.RING_WEBHOOK_HMAC_SECRET;
    try {
      const result = await handler({
        requestContext: { http: { method: 'POST', path: '/webhooks/ring' } },
        body: JSON.stringify({ meta: { version: '1' } }),
      });

      assert.equal(result.statusCode, 501);
    } finally {
      if (previousSecret === undefined) delete process.env.RING_WEBHOOK_HMAC_SECRET;
      else process.env.RING_WEBHOOK_HMAC_SECRET = previousSecret;
    }
  });

  test('runs scheduled analysis through the shared worker with the local in-memory default', async () => {
    const previousStore = process.env.EVENT_STORE;
    const previousRegion = process.env.AWS_REGION;
    const previousModel = process.env.BEDROCK_MODEL_ID;
    const previousHousehold = process.env.RING_HOUSEHOLD_ID;
    delete process.env.EVENT_STORE;
    delete process.env.AWS_REGION;
    delete process.env.BEDROCK_MODEL_ID;
    process.env.RING_HOUSEHOLD_ID = 'test-household';

    try {
      const result = await handler({
        source: 'tend.scheduler',
        detail: {
          householdId: 'test-household',
          asOf: '2026-09-17T10:00:00.000Z',
        },
      });

      assert.deepEqual(result, {
        status: 'analysis_complete',
        householdId: 'test-household',
        severity: 'NORMAL',
      });
    } finally {
      if (previousStore === undefined) delete process.env.EVENT_STORE;
      else process.env.EVENT_STORE = previousStore;
      if (previousRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = previousRegion;
      if (previousModel === undefined) delete process.env.BEDROCK_MODEL_ID;
      else process.env.BEDROCK_MODEL_ID = previousModel;
      if (previousHousehold === undefined) delete process.env.RING_HOUSEHOLD_ID;
      else process.env.RING_HOUSEHOLD_ID = previousHousehold;
    }
  });

  test('accepts base64-encoded HTTP bodies before handing them to the Ring adapter', async () => {
    const previousSecret = process.env.RING_WEBHOOK_HMAC_SECRET;
    delete process.env.RING_WEBHOOK_HMAC_SECRET;
    try {
      const body = JSON.stringify({ meta: { version: '1' } });
      const result = await handler({
        requestContext: { http: { method: 'POST', path: '/webhooks/ring' } },
        body: Buffer.from(body, 'utf8').toString('base64'),
        isBase64Encoded: true,
      });

      assert.equal(result.statusCode, 501);
    } finally {
      if (previousSecret === undefined) delete process.env.RING_WEBHOOK_HMAC_SECRET;
      else process.env.RING_WEBHOOK_HMAC_SECRET = previousSecret;
    }
  });
});
