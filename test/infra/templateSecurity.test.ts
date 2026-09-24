import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const template = readFileSync(resolve(process.cwd(), 'infra/template.yaml'), 'utf8');

describe('infra/template.yaml: production security invariants', () => {
  test('uses Node.js 22 for the Lambda runtime', () => {
    assert.match(template, /Runtime:\s*nodejs22\.x/);
  });

  test('marks the Ring HMAC secret as NoEcho', () => {
    assert.match(template, /RingWebhookHmacSecret:\s*\n\s*Type:\s*String\s*\n\s*NoEcho:\s*true/);
  });

  test('requires an explicit deployed household identity and wires it into the runtime', () => {
    assert.match(template, /RingHouseholdId:\s*\n\s*Type:\s*String\s*\n\s*MinLength:\s*1\s*\n\s*MaxLength:\s*128/);
    assert.match(template, /RING_HOUSEHOLD_ID:\s*!Ref RingHouseholdId/);
    assert.doesNotMatch(template, /RING_HOUSEHOLD_ID:\s*ring-household-1/);
  });

  test('keeps runtime DynamoDB permissions limited to the application table', () => {
    assert.match(template, /dynamodb:GetItem/);
    assert.match(template, /dynamodb:PutItem/);
    assert.match(template, /dynamodb:Query/);
    assert.match(template, /dynamodb:TransactWriteItems/);
    assert.match(template, /Resource:\s*!GetAtt TendEventsTable\.Arn/);
    assert.doesNotMatch(template, /dynamodb:\*/);
  });

  test('scopes Bedrock access to the configured foundation model', () => {
    assert.match(template, /Action:\s*\n\s*- bedrock:Converse/);
    assert.match(template, /foundation-model\/\$\{ModelId\}/);
    assert.doesNotMatch(template, /bedrock:\*/);
  });

  test('scopes SNS publish access to the Tend notification topic', () => {
    assert.match(template, /Action:\s*\n\s*- sns:Publish/);
    assert.match(template, /!Ref TendNotificationTopic/);
    assert.doesNotMatch(template, /sns:\*/);
  });

  test('scopes Scheduler trust to Tend\'s named schedule and account', () => {
    assert.match(template, /Name:\s*!Sub '\$\{AWS::StackName\}-analysis'/);
    assert.match(template, /aws:SourceArn:\s*!Sub/);
    assert.match(template, /schedule\/default\/\$\{AWS::StackName\}-analysis/);
    assert.match(template, /aws:SourceAccount:\s*!Ref AWS::AccountId/);
  });

  test('limits Scheduler permissions to invoking the Tend runtime', () => {
    assert.match(template, /Action:\s*\n\s*- lambda:InvokeFunction/);
    assert.match(template, /Resource:\s*\n\s*- !GetAtt TendRuntimeFunction\.Arn/);
    assert.doesNotMatch(template, /lambda:\*/);
  });

  test('enables DynamoDB point-in-time recovery and encryption', () => {
    assert.match(template, /PointInTimeRecoveryEnabled:\s*true/);
    assert.match(template, /SSEEnabled:\s*true/);
  });
});
