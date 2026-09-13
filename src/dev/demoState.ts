import { HouseholdSimulator, ScenarioName } from '../ingestion/simulator';
import { InMemoryEventStore } from '../store/inMemoryEventStore';
import { buildHouseholdBaseline } from '../engine/baselineEngine';
import { evaluateDeviation } from '../engine/deviationEngine';
import { TemplateReasoningService } from '../reasoning/templateReasoningService';
import { ReasoningInput, ReasoningOutput } from '../reasoning/contract';
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
  recentEvents: TendEvent[];
  sensitivities: ReturnType<SensitivityStore['all']>;
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
  private readonly reasoningService = new TemplateReasoningService();
  private currentScenario: ScenarioName = 'deviation_missing';
  private seeded = false;

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
    const reasoning = await this.reasoningService.explain(reasoningInput);

    const recentEvents = await this.eventStore.getRecent(HOUSEHOLD_ID, 20);

    return {
      todayIso: today.toISOString(),
      scenario: this.currentScenario,
      baseline,
      deviation,
      reasoning,
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
