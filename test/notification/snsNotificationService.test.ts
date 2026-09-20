import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnsNotificationService, SnsModules } from '../../src/notification/snsNotificationService';

class FakeCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

class FakeClient {
  static published: FakeCommand[] = [];
  async send(command: FakeCommand): Promise<void> {
    FakeClient.published.push(command);
  }
}

const modules: SnsModules = {
  SNSClient: FakeClient as unknown as SnsModules['SNSClient'],
  PublishCommand: FakeCommand as unknown as SnsModules['PublishCommand'],
};

test('SNS adapter publishes only the normalized notification content', async () => {
  FakeClient.published = [];
  const service = new SnsNotificationService('arn:aws:sns:test:123:tend', async () => modules);
  const result = await service.send({
    householdId: 'household-1',
    severity: 'MODERATE',
    explanation: 'Morning activity differs from the recent routine.',
    recommendedWording: 'Consider checking in.',
    notifyRecommended: true,
  });

  assert.deepEqual(result, { delivered: true });
  assert.equal(FakeClient.published.length, 1);
  const input = FakeClient.published[0].input;
  assert.equal(input.TopicArn, 'arn:aws:sns:test:123:tend');
  assert.equal(input.Subject, 'Tend routine update: MODERATE');
  assert.equal(typeof input.Message, 'string');
  assert.match(input.Message as string, /Morning activity differs/);
  assert.doesNotMatch(input.Message as string, /raw|payload|secret/i);
});

test('SNS adapter does not publish when notifyRecommended is false', async () => {
  FakeClient.published = [];
  const service = new SnsNotificationService('arn:aws:sns:test:123:tend', async () => modules);
  const result = await service.send({
    householdId: 'household-1',
    severity: 'NORMAL',
    explanation: 'No meaningful deviation was observed.',
    recommendedWording: 'No action needed.',
    notifyRecommended: false,
  });

  assert.deepEqual(result, {
    delivered: false,
    reason: 'notifyRecommended was false; no notification sent by design.',
  });
  assert.equal(FakeClient.published.length, 0);
});
