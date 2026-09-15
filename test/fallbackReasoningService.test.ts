import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackReasoningService } from '../src/reasoning/fallbackReasoningService';
import { ReasoningInput, ReasoningOutput, ReasoningService } from '../src/reasoning/contract';

function fakeInput(): ReasoningInput {
  return {
    householdContext: { daysOfBaseline: 10, confidence: 0.71 },
    deviation: { compositeScore: 0.1, severity: 'NORMAL', evidence: [] },
    recentFeedbackContext: [],
  };
}

function fakeOutput(overrides: Partial<ReasoningOutput> = {}): ReasoningOutput {
  return {
    severityLabel: 'NORMAL',
    explanation: 'fine',
    evidenceReferences: [],
    recommendedWording: 'No action needed.',
    confidence: 0.9,
    notifyRecommended: false,
    ...overrides,
  };
}

describe('reasoning/fallbackReasoningService: FallbackReasoningService', () => {
  test('uses the primary result when the primary succeeds, never touching the fallback', async () => {
    let fallbackCalled = false;
    const primary: ReasoningService = { explain: async () => fakeOutput({ explanation: 'from primary' }) };
    const fallback: ReasoningService = {
      explain: async () => {
        fallbackCalled = true;
        return fakeOutput({ explanation: 'from fallback' });
      },
    };
    const service = new FallbackReasoningService(primary, fallback);
    const result = await service.explain(fakeInput());
    assert.equal(result.explanation, 'from primary');
    assert.equal(fallbackCalled, false);
  });

  test('falls back when the primary throws, and still returns a valid result', async () => {
    const primary: ReasoningService = {
      explain: async () => {
        throw new Error('primary failed');
      },
    };
    const fallback: ReasoningService = { explain: async () => fakeOutput({ explanation: 'from fallback' }) };
    const service = new FallbackReasoningService(primary, fallback);
    const result = await service.explain(fakeInput());
    assert.equal(result.explanation, 'from fallback');
  });

  test('calls onFallback with a safe reason string, never with the input/output payloads', async () => {
    let capturedReason: string | undefined;
    const primary: ReasoningService = {
      explain: async () => {
        throw new Error('simulated failure reason');
      },
    };
    const fallback: ReasoningService = { explain: async () => fakeOutput() };
    const service = new FallbackReasoningService(primary, fallback, (reason) => {
      capturedReason = reason;
    });
    await service.explain(fakeInput());
    assert.equal(capturedReason, 'simulated failure reason');
  });

  test('does not call onFallback when the primary succeeds', async () => {
    let onFallbackCalled = false;
    const primary: ReasoningService = { explain: async () => fakeOutput() };
    const fallback: ReasoningService = { explain: async () => fakeOutput() };
    const service = new FallbackReasoningService(primary, fallback, () => {
      onFallbackCalled = true;
    });
    await service.explain(fakeInput());
    assert.equal(onFallbackCalled, false);
  });

  test('propagates a fallback failure if BOTH primary and fallback fail (never fabricates a result)', async () => {
    const primary: ReasoningService = {
      explain: async () => {
        throw new Error('primary failed');
      },
    };
    const fallback: ReasoningService = {
      explain: async () => {
        throw new Error('fallback also failed');
      },
    };
    const service = new FallbackReasoningService(primary, fallback);
    await assert.rejects(() => service.explain(fakeInput()), /fallback also failed/);
  });
});
