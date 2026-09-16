import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEventStore, EventStoreConfigError } from '../../src/store/eventStoreFactory';
import { InMemoryEventStore } from '../../src/store/inMemoryEventStore';
import { DynamoEventStore } from '../../src/store/dynamoEventStore';
import { DynamoConfigError } from '../../src/store/dynamoConfig';

describe('store/eventStoreFactory: createEventStore', () => {
  test('defaults to InMemoryEventStore when EVENT_STORE is not set at all', () => {
    const store = createEventStore({});
    assert.ok(store instanceof InMemoryEventStore);
  });

  test('returns InMemoryEventStore when EVENT_STORE=in_memory', () => {
    const store = createEventStore({ EVENT_STORE: 'in_memory' });
    assert.ok(store instanceof InMemoryEventStore);
  });

  test('returns DynamoEventStore when EVENT_STORE=dynamodb and AWS config is present', () => {
    const store = createEventStore({ EVENT_STORE: 'dynamodb', AWS_REGION: 'us-east-1', DYNAMODB_TABLE_NAME: 'tend-events' });
    assert.ok(store instanceof DynamoEventStore);
  });

  test('throws DynamoConfigError (not a silent in-memory fallback) when dynamodb is requested but unconfigured', () => {
    assert.throws(() => createEventStore({ EVENT_STORE: 'dynamodb' }), DynamoConfigError);
  });

  test('throws EventStoreConfigError for an unrecognized EVENT_STORE value', () => {
    assert.throws(() => createEventStore({ EVENT_STORE: 'redis' }), EventStoreConfigError);
  });

  test('local development never requires AWS configuration when EVENT_STORE is unset', () => {
    // Simulates the exact "zero AWS config" environment the CLI/tests run in.
    const store = createEventStore({});
    assert.ok(store instanceof InMemoryEventStore);
  });
});
