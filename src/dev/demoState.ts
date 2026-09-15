import { HouseholdSimulator, ScenarioName } from '../ingestion/simulator';
import { InMemoryEventStore } from '../store/inMemoryEventStore';
import { buildHouseholdBaseline } from '../engine/baselineEngine';
import { evaluateDeviation } from '../engine/deviationEngine';
import { TemplateReasoningService } from '../reasoning/templateReasoningService';
import { BedrockReasoningService } from '../reasoning/bedrockReasoningService';
import { FallbackReasoningService } from '../reasoning/fallbackReasoningService';
import { ReasoningInput, ReasoningOutput, ReasoningService } from '../reasoning/contract';
import { tryLoadBedrockConfig } from '../reasoning/bedrock/bedrockConfig';
import { BedrockClient } from '../reasoning/bedrock/bedrockClient';
import { BedrockModelInvoker } from '../reasoning/bedrock/bedrockReasoner';
import { SensitivityStore, applyFeedback } from '../feedback/feedbackEngine';
import { FeedbackEvent, FeedbackType } from '../domain/feedback';
import { HouseholdBaseline } from '../domain/baseline';
import { DeviationResult } from '../domain/deviation';
import { DEFAULT_CONFIG } from '../config/config';
import { TendEvent } from '../domain/event';

const HOUSEHOLD_ID = 'demo-household-1';
const SEED = 42;

export interface DemoSnapshot {
  todayIso: string;
  scenario: ScenarioName;
  baseline: HouseholdBaseline;
  deviation: DeviationResult;
  reasoning: ReasoningOutput;
  /**
   * Which reasoning provider actually produced `reasoning` this call.
   * Deliberately kept OUTSIDE the ReasoningOutput contract itself (see
   * contract.ts) — this is dev-server/demo presentation metadata, not part
   * of the provider-independent reasoning schema.
   */
  reasoningProvider: 'bedrock' | 'template';
  recentEvents: TendEvent[];
  sensitivities: ReturnType<SensitivityStore['all']>;
}

/**
 * Builds the reasoning service used by this demo state: a real Bedrock
 * path if (and only if) AWS_REGION/BEDROCK_MODEL_ID are configured, always
 * wrapped in a fallback to the deterministic TemplateReasoningService so
 * missing config, a missing AWS SDK, a network failure, or a malformed
 * model response can never break the dashboard or CLI. See
 * fallbackReasoningService.ts and README "AWS / Amazon Bedrock
 * Integration" for what this can and cannot prove.
 */
function buildReasoningService(onFallback: (reason: string) => void): { service: ReasoningService; bedrockConfigured: boolean } {
  const loaded = tryLoadBedrockConfig();
  const template = new TemplateReasoningService();

  if ('error' in loaded) {
    return { service: template, bedrockConfigured: false };
  }

  const bedrock = new BedrockReasoningService(new BedrockModelInvoker(new BedrockClient(loaded.config)));
  return { service: new FallbackReasoningService(bedrock, template, onFallback), bedrockConfigured: true };
}

/**
 * Owns all in-memory state for the local dev demo/dashboard. This is
 * explicitly a development convenience, not a production data layer — see
 * store/eventStore.ts for the storage-agnostic interface a real backend
 * would implement.
 */
export class DemoState {
  private readonly simulator = new HouseholdSimulator({ householdId: HOUSEHOLD_ID, seed: SEED });
  private eventStore = new InMemoryEventStore();
  private readonly sensitivityStore = new SensitivityStore();
  private readonly reasoningService: ReasoningService;
  private readonly bedrockConfigured: boolean;
  private lastFallbackReason: string | undefined;
  private currentScenario: ScenarioName = 'deviation_missing';
  private seeded = false;

  constructor() {
    const built = buildReasoningService((reason) => {
      // Safe to log: `reason` is an Error#message from our own config/SDK/
      // network code, never the ReasoningInput/Output payloads themselves.
      this.lastFallbackReason = reason;
      // eslint-disable-next-line no-console
      console.warn(`Bedrock reasoning unavailable this call, falling back to the deterministic template: ${reason}`);
    });
    this.reasoningService = built.service;
    this.bedrockConfigured = built.bedrockConfigured;
  }

  async ensureSeeded(today: Date): Promise<void> {
    if (this.seeded) return;
    const historical = this.simulator.generateHistoricalWindow(today, DEFAULT_CONFIG.defaultWindowDays);
    for (const event of historical) {
      await this.eventStore.append(event);
    }
    this.seeded = true;
  }

  async setScenario(scenario: ScenarioName, today: Date): Promise<void> {
    this.currentScenario = scenario;
    // Remove any previously-generated "today" events for a clean re-run by
    // rebuilding the store: simplest correct approach for a dev tool.
    const historical = await this.eventStore.getByHousehold(HOUSEHOLD_ID);
    const todayKey = today.toISOString().slice(0, 10);
    const withoutToday = historical.filter((e) => !e.occurredAt.startsWith(todayKey));

    const freshStore = new InMemoryEventStore();
    for (const event of withoutToday) {
      await freshStore.append(event);
    }
    this.eventStore = freshStore;

    const todaysEvents = this.simulator.generateDay(today, scenario);
    for (const event of todaysEvents) {
      await this.eventStore.append(event);
    }
  }

  async snapshot(today: Date, asOf: Date): Promise<DemoSnapshot> {
    await this.ensureSeeded(today);

    const allEvents = await this.eventStore.getByHousehold(HOUSEHOLD_ID);
    const baseline = buildHouseholdBaseline(HOUSEHOLD_ID, allEvents, today);

    const todayKey = today.toISOString().slice(0, 10);
    const todaysEvents = allEvents.filter((e) => e.occurredAt.startsWith(todayKey));

    const deviation = evaluateDeviation(baseline, todaysEvents, today, asOf);

    const reasoningInput: ReasoningInput = {
      householdContext: { daysOfBaseline: baseline.daysObserved, confidence: baseline.confidence },
      deviation: {
        compositeScore: deviation.compositeScore,
        severity: deviation.severity,
        evidence: deviation.evidence,
      },
      recentFeedbackContext: [],
    };
    this.lastFallbackReason = undefined;
    const reasoning = await this.reasoningService.explain(reasoningInput);
    const reasoningProvider: DemoSnapshot['reasoningProvider'] = this.bedrockConfigured && this.lastFallbackReason === undefined ? 'bedrock' : 'template';

    const recentEvents = await this.eventStore.getRecent(HOUSEHOLD_ID, 20);

    return {
      todayIso: today.toISOString(),
      scenario: this.currentScenario,
      baseline,
      deviation,
      reasoning,
      reasoningProvider,
      recentEvents,
      sensitivities: this.sensitivityStore.all(),
    };
  }

  async submitFeedback(deviationId: string, feedbackType: FeedbackType, affectedSignals: string[], timestamp: string): Promise<void> {
    const feedback: FeedbackEvent = {
      householdId: HOUSEHOLD_ID,
      deviationId,
      feedbackType,
      affectedSignals,
      timestamp,
    };
    applyFeedback(this.sensitivityStore, feedback, DEFAULT_CONFIG);
  }

  get householdId(): string {
    return HOUSEHOLD_ID;
  }
}
