import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoConfigError, loadDynamoEventStoreConfig, tryLoadDynamoEventStoreConfig } from '../../src/store/dynamoConfig';

describe('store/dynamoConfig: loadDynamoEventStoreConfig', () => {
  test('throws when AWS_REGION is missing', () => {
    assert.throws(() => loadDynamoEventStoreConfig({ DYNAMODB_TABLE_NAME: 'tend-events' }), DynamoConfigError);
  });

  test('throws when DYNAMODB_TABLE_NAME is missing', () => {
    assert.throws(() => loadDynamoEventStoreConfig({ AWS_REGION: 'us-east-1' }), DynamoConfigError);
  });

  test('loads successfully with a valid minimal environment', () => {
    const config = loadDynamoEventStoreConfig({ AWS_REGION: 'us-east-1', DYNAMODB_TABLE_NAME: 'tend-events' });
    assert.equal(config.region, 'us-east-1');
    assert.equal(config.tableName, 'tend-events');
  });

  test('never reads AWS credential-shaped environment variables into the config object', () => {
    const config = loadDynamoEventStoreConfig({
      AWS_REGION: 'us-east-1',
      DYNAMODB_TABLE_NAME: 'tend-events',
      AWS_ACCESS_KEY_ID: 'should-never-appear',
      AWS_SECRET_ACCESS_KEY: 'should-never-appear-either',
    });
    assert.equal(JSON.stringify(config).includes('should-never-appear'), false);
  });
});

describe('store/dynamoConfig: tryLoadDynamoEventStoreConfig', () => {
  test('returns an error string instead of throwing when configuration is missing', () => {
    const result = tryLoadDynamoEventStoreConfig({});
    assert.ok('error' in result);
  });

  test('returns a config object when configuration is valid', () => {
    const result = tryLoadDynamoEventStoreConfig({ AWS_REGION: 'us-east-1', DYNAMODB_TABLE_NAME: 'tend-events' });
    assert.ok('config' in result);
  });
});
