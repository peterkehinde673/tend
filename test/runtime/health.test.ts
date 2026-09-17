import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../../src/runtime/lambdaHandler';

test('production runtime health endpoint returns safe operational status', async () => {
  const previous = process.env.EVENT_STORE;
  process.env.EVENT_STORE = 'dynamodb';
  try {
    const result = await handler({ requestContext: { http: { method: 'GET', path: '/health' } } });
    assert.equal('statusCode' in result ? result.statusCode : undefined, 200);
    assert.match('statusCode' in result ? result.body : '', /"status":"ok"/);
    assert.match('statusCode' in result ? result.body : '', /"eventStore":"dynamodb"/);
  } finally {
    if (previous === undefined) delete process.env.EVENT_STORE;
    else process.env.EVENT_STORE = previous;
  }
});
