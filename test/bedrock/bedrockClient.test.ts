import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockClient, extractConverseText } from '../../src/reasoning/bedrock/bedrockClient';
import { BedrockSdkUnavailableError } from '../../src/reasoning/bedrock/bedrockTypes';

const FAKE_CONFIG = { region: 'us-east-1', modelId: 'fake-model-id' };

describe('bedrock/bedrockClient: SDK-unavailable path — this is a REAL test, not mocked', () => {
  test('converse() throws BedrockSdkUnavailableError when the SDK loader fails', async () => {
    const client = new BedrockClient(FAKE_CONFIG, async () => {
      throw new Error('simulated missing package');
    });
    await assert.rejects(
      () => client.converse('system prompt', 'user message'),
      (err: unknown) => {
        assert.ok(err instanceof BedrockSdkUnavailableError);
        assert.match((err as Error).message, /Could not load the "@aws-sdk\/client-bedrock-runtime" package/);
        return true;
      },
    );
  });

  test('the SDK-unavailable error never includes the system prompt or user message content', async () => {
    const client = new BedrockClient(FAKE_CONFIG, async () => {
      throw new Error('simulated missing package');
    });
    try {
      await client.converse('SENSITIVE_SYSTEM_PROMPT_MARKER', 'SENSITIVE_USER_MESSAGE_MARKER');
      assert.fail('expected converse() to throw');
    } catch (err) {
      const message = (err as Error).message;
      assert.equal(message.includes('SENSITIVE_SYSTEM_PROMPT_MARKER'), false);
      assert.equal(message.includes('SENSITIVE_USER_MESSAGE_MARKER'), false);
    }
  });
});

describe('bedrock/bedrockClient: extractConverseText — defensive response parsing', () => {
  test('extracts text from a well-formed Converse response', () => {
    const response = { output: { message: { content: [{ text: 'hello world' }] } } };
    assert.equal(extractConverseText(response), 'hello world');
  });

  test('returns undefined for a response missing output', () => {
    assert.equal(extractConverseText({}), undefined);
  });

  test('returns undefined for a response with an empty content array', () => {
    const response = { output: { message: { content: [] } } };
    assert.equal(extractConverseText(response), undefined);
  });

  test('returns undefined for a response where content[0].text is not a string', () => {
    const response = { output: { message: { content: [{ text: 12345 }] } } };
    assert.equal(extractConverseText(response), undefined);
  });

  test('never throws on null/undefined/primitive input', () => {
    assert.doesNotThrow(() => extractConverseText(null));
    assert.doesNotThrow(() => extractConverseText(undefined));
    assert.doesNotThrow(() => extractConverseText('a string'));
    assert.doesNotThrow(() => extractConverseText(42));
    assert.equal(extractConverseText(null), undefined);
  });
});
