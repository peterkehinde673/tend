import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockConfigError, loadBedrockConfig, tryLoadBedrockConfig } from '../../src/reasoning/bedrock/bedrockConfig';

describe('bedrock/bedrockConfig: loadBedrockConfig', () => {
  test('throws BedrockConfigError when AWS_REGION is missing', () => {
    assert.throws(() => loadBedrockConfig({ BEDROCK_MODEL_ID: 'fake-model-id' }), BedrockConfigError);
  });

  test('throws BedrockConfigError when BEDROCK_MODEL_ID is missing', () => {
    assert.throws(() => loadBedrockConfig({ AWS_REGION: 'us-east-1' }), BedrockConfigError);
  });

  test('throws BedrockConfigError when both are missing', () => {
    assert.throws(() => loadBedrockConfig({}), BedrockConfigError);
  });

  test('loads successfully with a valid minimal environment', () => {
    const config = loadBedrockConfig({ AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'fake-model-id' });
    assert.equal(config.region, 'us-east-1');
    assert.equal(config.modelId, 'fake-model-id');
  });

  test('never reads AWS credential-shaped environment variables into the config object', () => {
    const config = loadBedrockConfig({
      AWS_REGION: 'us-east-1',
      BEDROCK_MODEL_ID: 'fake-model-id',
      AWS_ACCESS_KEY_ID: 'should-never-appear',
      AWS_SECRET_ACCESS_KEY: 'should-never-appear-either',
    });
    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes('should-never-appear'), false);
  });
});

describe('bedrock/bedrockConfig: tryLoadBedrockConfig', () => {
  test('returns an error string instead of throwing when configuration is missing', () => {
    const result = tryLoadBedrockConfig({});
    assert.ok('error' in result);
    if ('error' in result) {
      assert.match(result.error, /AWS_REGION/);
    }
  });

  test('returns a config object when configuration is valid', () => {
    const result = tryLoadBedrockConfig({ AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'fake-model-id' });
    assert.ok('config' in result);
  });
});
