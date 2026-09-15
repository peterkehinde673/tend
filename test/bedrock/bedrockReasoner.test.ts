import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockModelInvoker } from '../../src/reasoning/bedrock/bedrockReasoner';
import { BedrockClient } from '../../src/reasoning/bedrock/bedrockClient';
import { ReasoningInput } from '../../src/reasoning/contract';

function fakeInput(): ReasoningInput {
  return {
    householdContext: { daysOfBaseline: 10, confidence: 0.71 },
    deviation: {
      compositeScore: 1.5,
      severity: 'MODERATE',
      evidence: [{ signal: 'kitchen_presence', expectedWindow: '07:20-07:45', observed: false, minutesPastWindow: 54, confidence: 0.86 }],
    },
    recentFeedbackContext: [],
  };
}

describe('bedrock/bedrockReasoner: BedrockModelInvoker delegation', () => {
  test('passes the system prompt and JSON-serialized ReasoningInput through to the client unchanged', async () => {
    let capturedSystemPrompt: string | undefined;
    let capturedUserMessage: string | undefined;

    const fakeClient = {
      converse: async (systemPrompt: string, userMessage: string) => {
        capturedSystemPrompt = systemPrompt;
        capturedUserMessage = userMessage;
        return '{"ok":true}';
      },
    } as unknown as BedrockClient;

    const invoker = new BedrockModelInvoker(fakeClient);
    const input = fakeInput();
    const result = await invoker.invoke('SYSTEM_PROMPT_TEXT', input);

    assert.equal(capturedSystemPrompt, 'SYSTEM_PROMPT_TEXT');
    assert.deepEqual(JSON.parse(capturedUserMessage!), input);
    assert.equal(result, '{"ok":true}');
  });

  test('propagates a client failure rather than swallowing it', async () => {
    const failingClient = {
      converse: async () => {
        throw new Error('simulated Bedrock failure');
      },
    } as unknown as BedrockClient;

    const invoker = new BedrockModelInvoker(failingClient);
    await assert.rejects(() => invoker.invoke('prompt', fakeInput()), /simulated Bedrock failure/);
  });
});
