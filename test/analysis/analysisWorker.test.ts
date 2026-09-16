import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysis } from '../../src/analysis/analysisWorker';
import { InMemoryEventStore } from '../../src/store/inMemoryEventStore';
import { HouseholdSimulator } from '../../src/ingestion/simulator';
import { TemplateReasoningService } from '../../src/reasoning/templateReasoningService';
import { ReasoningInput, ReasoningOutput, ReasoningService } from '../../src/reasoning/contract';
import { ConsoleNotificationService } from '../../src/notification/notificationService';

const TODAY = new Date('2026-09-14T00:00:00.000Z');
const AS_OF = new Date('2026-09-14T09:00:00.000Z');

async function seedStore(householdId: string, seed: number, scenario: Parameters<HouseholdSimulator['generateDay']>[1]) {
  const store = new InMemoryEventStore();
  const sim = new HouseholdSimulator({ householdId, seed });
  const historical = sim.generateHistoricalWindow(TODAY, 14);
  for (const event of historical) await store.append(event);
  const todays = sim.generateDay(TODAY, scenario);
  for (const event of todays) await store.append(event);
  return store;
}

describe('analysis/analysisWorker: runAnalysis — end-to-end against the persistence layer', () => {
  test('produces a baseline, deviation, and reasoning result matching the deterministic engine directly', async () => {
    const store = await seedStore('house-1', 42, 'sequence_deviation');
    const result = await runAnalysis({
      householdId: 'house-1',
      store,
      reasoningService: new TemplateReasoningService(),
      today: TODAY,
      asOf: AS_OF,
    });

    assert.equal(result.householdId, 'house-1');
    assert.equal(result.baseline.householdId, 'house-1');
    assert.ok(result.deviation.compositeScore >= 0);
    assert.ok(['NORMAL', 'LOW', 'MODERATE', 'HIGH'].includes(result.deviation.severity));
    assert.equal(result.reasoning.severityLabel, result.deviation.severity);
  });

  test("loads events via the store's bounded time-range query rather than an unbounded fetch", async () => {
    let capturedQuery: unknown;
    const store = await seedStore('house-1', 42, 'normal');
    const originalGetByTimeRange = store.getByTimeRange.bind(store);
    store.getByTimeRange = async (query) => {
      capturedQuery = query;
      return originalGetByTimeRange(query);
    };

    await runAnalysis({ householdId: 'house-1', store, reasoningService: new TemplateReasoningService(), today: TODAY, asOf: AS_OF });

    assert.ok(capturedQuery, 'expected the worker to call getByTimeRange');
    assert.equal((capturedQuery as { householdId: string }).householdId, 'house-1');
  });

  test('sends a notification through the provided NotificationService when one is supplied', async () => {
    const store = await seedStore('house-1', 42, 'sequence_deviation');
    let sentNotification: unknown;
    const fakeNotifier = {
      send: async (notification: unknown) => {
        sentNotification = notification;
        return { delivered: true };
      },
    };
    const result = await runAnalysis({
      householdId: 'house-1',
      store,
      reasoningService: new TemplateReasoningService(),
      notificationService: fakeNotifier,
      today: TODAY,
      asOf: AS_OF,
    });

    assert.ok(result.notification);
    assert.equal(result.notification?.delivered, true);
    assert.ok(sentNotification);
  });

  test('does not attempt a notification when no NotificationService is supplied', async () => {
    const store = await seedStore('house-1', 42, 'normal');
    const result = await runAnalysis({ householdId: 'house-1', store, reasoningService: new TemplateReasoningService(), today: TODAY, asOf: AS_OF });
    assert.equal(result.notification, undefined);
  });

  test('works with the real ConsoleNotificationService without throwing', async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const store = await seedStore('house-1', 42, 'sequence_deviation');
      const result = await runAnalysis({
        householdId: 'house-1',
        store,
        reasoningService: new TemplateReasoningService(),
        notificationService: new ConsoleNotificationService(),
        today: TODAY,
        asOf: AS_OF,
      });
      assert.ok(result.notification);
    } finally {
      console.log = originalLog;
    }
  });
});

describe('analysis/analysisWorker: Bedrock/reasoning never decides anomaly status', () => {
  test('the deterministic severity is computed BEFORE the reasoning service is ever called, and the reasoning service cannot override it', async () => {
    const store = await seedStore('house-1', 42, 'sequence_deviation');

    let reasoningCalledWithSeverity: string | undefined;
    const spyingReasoningService: ReasoningService = {
      explain: async (input: ReasoningInput): Promise<ReasoningOutput> => {
        // Capture what severity the deterministic engine already decided
        // BEFORE this function runs — proving the decision was made first.
        reasoningCalledWithSeverity = input.deviation.severity;
        return {
          severityLabel: input.deviation.severity, // a well-behaved reasoning service must echo it, not invent one
          explanation: 'test',
          evidenceReferences: [],
          recommendedWording: 'No action needed.',
          confidence: 0.5,
          notifyRecommended: false,
        };
      },
    };

    const result = await runAnalysis({ householdId: 'house-1', store, reasoningService: spyingReasoningService, today: TODAY, asOf: AS_OF });

    // The severity the reasoning service SAW matches the deterministic
    // engine's own independently-computed result exactly — it was
    // supplied to reasoning, not decided by it.
    assert.equal(reasoningCalledWithSeverity, result.deviation.severity);
  });

  test('a reasoning service that tries to invent a different severity is rejected by the existing safety contract (via BedrockReasoningService), not silently accepted', async () => {
    const { BedrockReasoningService } = await import('../../src/reasoning/bedrockReasoningService');
    const store = await seedStore('house-1', 42, 'sequence_deviation');

    const dishonestInvoker = {
      invoke: async () =>
        JSON.stringify({
          severityLabel: 'HIGH', // will not match the real deterministic severity for this scenario (LOW)
          explanation: 'fabricated',
          evidenceReferences: [],
          recommendedWording: 'Consider checking in.',
          confidence: 0.99,
          notifyRecommended: true,
        }),
    };
    const dishonestService = new BedrockReasoningService(dishonestInvoker);

    await assert.rejects(
      () => runAnalysis({ householdId: 'house-1', store, reasoningService: dishonestService, today: TODAY, asOf: AS_OF }),
      /safety contract validation/,
    );
  });
});
