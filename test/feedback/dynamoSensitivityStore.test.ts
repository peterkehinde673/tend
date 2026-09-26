import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoSensitivityStore, SensitivityDynamoModules } from '../../src/feedback/dynamoSensitivityStore';
import { DEFAULT_CONFIG } from '../../src/config/config';
import { SignalSensitivity } from '../../src/domain/feedback';

class FakeCommand { constructor(public readonly input: Record<string, unknown>) {} }
class FakeClient {
  static store = new Map<string, Record<string, unknown>>();
  async send(command: FakeCommand): Promise<{ Item?: Record<string, unknown> }> {
    const input = command.input;
    const key = input.Key as { pk: string; sk: string } | undefined;
    if (key) return { Item: FakeClient.store.get(`${key.pk}|${key.sk}`) };
    const item = input.Item as Record<string, unknown>;
    FakeClient.store.set(`${item.pk}|${item.sk}`, item);
    return {};
  }
}

const modules: SensitivityDynamoModules = {
  DynamoDBClient: FakeClient as unknown as SensitivityDynamoModules['DynamoDBClient'],
  DynamoDBDocumentClient: { from: () => new FakeClient() },
  GetCommand: FakeCommand as unknown as SensitivityDynamoModules['GetCommand'],
  PutCommand: FakeCommand as unknown as SensitivityDynamoModules['PutCommand'],
};

test('DynamoSensitivityStore creates defaults and persists updated state', async () => {
  FakeClient.store.clear();
  const store = new DynamoSensitivityStore({ region: 'test-region', tableName: 'tend' }, async () => modules);

  const fresh = await store.get('household-1', 'presence', DEFAULT_CONFIG);
  assert.equal(fresh.multiplier, 1);
  assert.deepEqual(fresh.recentFeedback, []);

  const updated: SignalSensitivity = {
    ...fresh,
    multiplier: 1.2,
    lastUpdatedAt: '2026-09-17T10:00:00.000Z',
    recentFeedback: [],
  };
  await store.put(updated);

  const loaded = await store.get('household-1', 'presence', DEFAULT_CONFIG);
  assert.deepEqual(loaded, updated);
});
