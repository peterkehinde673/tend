import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRingConfig, redactToken, RingConfigError, tryLoadRingConfig } from '../../src/ingestion/ring/ringConfig';

describe('ring/ringConfig: loadRingConfig', () => {
  test('throws RingConfigError when RING_ACCESS_TOKEN is missing', () => {
    assert.throws(() => loadRingConfig({ RING_EVENT_SOURCE: 'ring_real' }), RingConfigError);
  });

  test('throws RingConfigError when RING_EVENT_SOURCE is missing', () => {
    assert.throws(() => loadRingConfig({ RING_ACCESS_TOKEN: 'fake-token-value' }), RingConfigError);
  });

  test('throws RingConfigError when RING_EVENT_SOURCE has an invalid value', () => {
    assert.throws(
      () => loadRingConfig({ RING_ACCESS_TOKEN: 'fake-token-value', RING_EVENT_SOURCE: 'something_else' }),
      RingConfigError,
    );
  });

  test('loads successfully with a valid minimal environment, defaulting the API base URL', () => {
    const config = loadRingConfig({ RING_ACCESS_TOKEN: 'fake-token-value', RING_EVENT_SOURCE: 'ring_playground' });
    assert.equal(config.accessToken, 'fake-token-value');
    assert.equal(config.source, 'ring_playground');
    assert.equal(config.apiBaseUrl, 'https://api.amazonvision.com');
    assert.equal(config.webhookHmacSecret, undefined);
  });

  test('honors an overridden RING_API_BASE_URL', () => {
    const config = loadRingConfig({
      RING_ACCESS_TOKEN: 'fake-token-value',
      RING_EVENT_SOURCE: 'ring_real',
      RING_API_BASE_URL: 'https://example-staging.test',
    });
    assert.equal(config.apiBaseUrl, 'https://example-staging.test');
  });

  test('picks up RING_WEBHOOK_HMAC_SECRET when present', () => {
    const config = loadRingConfig({
      RING_ACCESS_TOKEN: 'fake-token-value',
      RING_EVENT_SOURCE: 'ring_real',
      RING_WEBHOOK_HMAC_SECRET: 'fake-hmac-secret',
    });
    assert.equal(config.webhookHmacSecret, 'fake-hmac-secret');
  });
});

describe('ring/ringConfig: tryLoadRingConfig', () => {
  test('returns an error string instead of throwing when configuration is missing', () => {
    const result = tryLoadRingConfig({});
    assert.ok('error' in result);
    if ('error' in result) {
      assert.match(result.error, /RING_ACCESS_TOKEN/);
    }
  });

  test('returns a config object when configuration is valid', () => {
    const result = tryLoadRingConfig({ RING_ACCESS_TOKEN: 'fake-token-value', RING_EVENT_SOURCE: 'ring_real' });
    assert.ok('config' in result);
  });
});

describe('ring/ringConfig: redactToken', () => {
  test('never includes the actual token value', () => {
    const secretValue = 'super-secret-token-value-123456';
    const redacted = redactToken(secretValue);
    assert.equal(redacted.includes(secretValue), false);
    assert.match(redacted, /redacted/);
  });

  test('reports absence clearly when no token is set', () => {
    assert.equal(redactToken(undefined), '(not set)');
  });
});
