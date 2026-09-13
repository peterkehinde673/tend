import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_RECOMMENDED_WORDING,
  ReasoningInput,
  ReasoningOutput,
  validateReasoningOutput,
} from '../src/reasoning/contract';
import { BedrockReasoningService, buildSystemPrompt, ModelInvoker } from '../src/reasoning/bedrockReasoningService';
import { TemplateReasoningService } from '../src/reasoning/templateReasoningService';

function makeInput(overrides: Partial<ReasoningInput> = {}): ReasoningInput {
  return {
    householdContext: { daysOfBaseline: 10, confidence: 0.71 },
    deviation: {
      compositeScore: 1.5,
      severity: 'MODERATE',
      evidence: [
        { signal: 'kitchen_presence', expectedWindow: '07:20-07:45', observed: false, minutesPastWindow: 54, confidence: 0.86 },
      ],
    },
    recentFeedbackContext: [],
    ...overrides,
  };
}

function makeValidOutput(input: ReasoningInput, overrides: Partial<ReasoningOutput> = {}): ReasoningOutput {
  return {
    severityLabel: input.deviation.severity,
    explanation:
      'No activity has been observed in the kitchen 54 minutes after the household\'s usual 07:20-07:45 window.',
    evidenceReferences: ['kitchen_presence'],
    recommendedWording: 'Consider checking in.',
    confidence: 0.79,
    notifyRecommended: true,
    ...overrides,
  };
}

describe('reasoning/contract: validateReasoningOutput — valid cases', () => {
  test('a well-formed, grounded output passes validation', () => {
    const input = makeInput();
    const output = makeValidOutput(input);
    assert.deepEqual(validateReasoningOutput(output, input), []);
  });

  test('a NORMAL severity output with no evidence references is valid when no evidence was supplied', () => {
    const input = makeInput({ deviation: { compositeScore: 0.1, severity: 'NORMAL', evidence: [] } });
    const output: ReasoningOutput = {
      severityLabel: 'NORMAL',
      explanation: "Today's activity is consistent with the household's usual routine.",
      evidenceReferences: [],
      recommendedWording: 'No action needed.',
      confidence: 0.9,
      notifyRecommended: false,
    };
    assert.deepEqual(validateReasoningOutput(output, input), []);
  });
});

describe('reasoning/contract: validateReasoningOutput — violations', () => {
  test('rejects a severity label that does not match the deterministic classification', () => {
    const input = makeInput();
    const output = makeValidOutput(input, { severityLabel: 'HIGH' });
    const problems = validateReasoningOutput(output, input);
    assert.ok(problems.some((p) => p.includes('severityLabel')));
  });

  test('rejects an evidence reference not present in the input', () => {
    const input = makeInput();
    const output = makeValidOutput(input, { evidenceReferences: ['made_up_signal'] });
    const problems = validateReasoningOutput(output, input);
    assert.ok(problems.some((p) => p.includes('made_up_signal')));
  });

  test('rejects empty evidenceReferences when evidence was actually supplied', () => {
    const input = makeInput();
    const output = makeValidOutput(input, { evidenceReferences: [] });
    const problems = validateReasoningOutput(output, input);
    assert.ok(problems.some((p) => p.includes('evidenceReferences is empty')));
  });

  test('rejects recommendedWording outside the fixed allowlist', () => {
    const input = makeInput();
    const output = makeValidOutput(input, { recommendedWording: 'Call emergency services immediately!' });
    const problems = validateReasoningOutput(output, input);
    assert.ok(problems.some((p) => p.includes('recommendedWording')));
  });

  for (const bannedPhrase of ['This may be a medical emergency.', 'The person appears to have fallen.', 'Facial recognition confirms it is Grandma.', 'This suggests a possible stroke.']) {
    test(`rejects explanation text containing forbidden language: "${bannedPhrase}"`, () => {
      const input = makeInput();
      const output = makeValidOutput(input, { explanation: bannedPhrase });
      const problems = validateReasoningOutput(output, input);
      assert.ok(problems.length > 0, `expected a violation for: ${bannedPhrase}`);
    });
  }

  test('rejects an explanation that invents a number not present in the evidence', () => {
    const input = makeInput();
    const output = makeValidOutput(input, {
      explanation: 'No kitchen activity has been observed for 999 minutes, which is highly unusual.',
    });
    const problems = validateReasoningOutput(output, input);
    assert.ok(problems.some((p) => p.includes('invented number') || p.includes('999')));
  });

  test('rejects out-of-range confidence values', () => {
    const input = makeInput();
    const output = makeValidOutput(input, { confidence: 1.5 });
    const problems = validateReasoningOutput(output, input);
    assert.ok(problems.some((p) => p.includes('confidence')));
  });
});

describe('reasoning/contract: allowlist completeness', () => {
  test('the allowlist contains only non-emergency, non-diagnostic phrasing', () => {
    for (const phrase of ALLOWED_RECOMMENDED_WORDING) {
      assert.doesNotMatch(phrase.toLowerCase(), /emergency|911|diagnos|call\s+(a\s+)?(doctor|ambulance)/);
    }
  });
});

describe('reasoning/bedrockReasoningService: evidence-only input, contract enforcement', () => {
  test('the system prompt encodes the hard safety constraints', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /You MUST NOT/);
    assert.match(prompt, /diagnos/i);
    assert.match(prompt, /emergency/i);
    assert.match(prompt, /facial recognition/i);
    assert.match(prompt, /Consider checking in/);
  });

  test('a mock model invoker only ever receives the structured evidence input, never a raw event payload', async () => {
    const input = makeInput();
    let capturedPayload: ReasoningInput | undefined;
    const mockInvoker: ModelInvoker = {
      invoke: async (_systemPrompt, userPayload) => {
        capturedPayload = userPayload;
        return JSON.stringify(makeValidOutput(input));
      },
    };
    const service = new BedrockReasoningService(mockInvoker);
    const output = await service.explain(input);

    assert.deepEqual(capturedPayload, input);
    assert.equal(output.severityLabel, 'MODERATE');
    // Confirm the payload has no raw-event-shaped fields (e.g. deviceId, occurredAt).
    assert.equal(JSON.stringify(capturedPayload).includes('deviceId'), false);
    assert.equal(JSON.stringify(capturedPayload).includes('occurredAt'), false);
  });

  test('throws when the model returns output that fails contract validation', async () => {
    const input = makeInput();
    const badInvoker: ModelInvoker = {
      invoke: async () => JSON.stringify(makeValidOutput(input, { recommendedWording: 'Call 911 now.' })),
    };
    const service = new BedrockReasoningService(badInvoker);
    await assert.rejects(() => service.explain(input), /safety contract validation/);
  });

  test('throws when the model returns non-JSON output', async () => {
    const input = makeInput();
    const brokenInvoker: ModelInvoker = { invoke: async () => 'not json at all' };
    const service = new BedrockReasoningService(brokenInvoker);
    await assert.rejects(() => service.explain(input), /non-JSON/);
  });
});

describe('reasoning/templateReasoningService: offline deterministic fallback', () => {
  test('always produces contract-valid output for a variety of severities', async () => {
    const service = new TemplateReasoningService();
    for (const severity of ['NORMAL', 'LOW', 'MODERATE', 'HIGH'] as const) {
      const input = makeInput({
        deviation: {
          compositeScore: 2.5,
          severity,
          evidence:
            severity === 'NORMAL'
              ? []
              : [{ signal: 'kitchen_presence', expectedWindow: '07:20-07:45', observed: false, minutesPastWindow: 54, confidence: 0.86 }],
        },
      });
      const output = await service.explain(input);
      const problems = validateReasoningOutput(output, input);
      assert.deepEqual(problems, [], `TemplateReasoningService produced an invalid output for severity ${severity}: ${JSON.stringify(output)}`);
    }
  });
});
