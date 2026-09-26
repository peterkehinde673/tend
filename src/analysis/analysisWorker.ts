import { EventStore } from '../store/eventStore';
import { buildHouseholdBaseline } from '../engine/baselineEngine';
import { evaluateDeviation } from '../engine/deviationEngine';
import { HouseholdBaseline } from '../domain/baseline';
import { DeviationResult } from '../domain/deviation';
import { ReasoningInput, ReasoningOutput, ReasoningService } from '../reasoning/contract';
import { NotificationService, DigestNotification } from '../notification/notificationService';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';
import { SensitivityStore } from '../feedback/sensitivityStore';
import { InMemorySensitivityStore } from '../feedback/sensitivityStoreFactory';

/**
 * Shared application boundary for scheduled analysis. Ring events are loaded
 * from the EventStore, deterministic analysis runs first, caregiver-learned
 * sensitivity is applied to scoring, and only then does reasoning receive
 * structured evidence.
 *
 * The worker remains usable without a persistent sensitivity store: local
 * callers get default sensitivity (multiplier 1.0), while AWS can inject the
 * DynamoDB-backed implementation created by the runtime factory.
 */
export interface AnalysisWorkerOptions {
  householdId: string;
  store: EventStore;
  reasoningService: ReasoningService;
  sensitivityStore?: SensitivityStore;
  notificationService?: NotificationService;
  today: Date;
  asOf: Date;
  windowDays?: number;
  config?: TendConfig;
}

export interface AnalysisWorkerResult {
  householdId: string;
  baseline: HouseholdBaseline;
  deviation: DeviationResult;
  reasoning: ReasoningOutput;
  notification?: { delivered: boolean; reason?: string };
}

export async function runAnalysis(options: AnalysisWorkerOptions): Promise<AnalysisWorkerResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const windowDays = options.windowDays ?? config.defaultWindowDays;
  const windowStart = new Date(options.today.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const events = await options.store.getByTimeRange({ householdId: options.householdId, fromIso: windowStart.toISOString(), toIso: options.asOf.toISOString() });
  const baseline = buildHouseholdBaseline(options.householdId, events, options.today, config, windowDays);
  const todayKey = options.today.toISOString().slice(0, 10);
  const todaysEvents = events.filter((e) => e.occurredAt.startsWith(todayKey));

  const sensitivityStore = options.sensitivityStore ?? new InMemorySensitivityStore();
  const signalKeys = new Set<string>([
    ...Object.keys(baseline.bucketStats),
    ...Object.keys(baseline.timingStats),
    ...todaysEvents.map((event) => event.zoneId ?? event.deviceId),
  ]);
  const signalSensitivity: Record<string, number> = {};
  await Promise.all([...signalKeys].map(async (signal) => {
    const state = await sensitivityStore.get(options.householdId, signal, config);
    signalSensitivity[signal] = state.multiplier;
  }));

  const deviation = evaluateDeviation(baseline, todaysEvents, options.today, options.asOf, config, signalSensitivity);
  const reasoningInput: ReasoningInput = {
    householdContext: { daysOfBaseline: baseline.daysObserved, confidence: baseline.confidence },
    deviation: { compositeScore: deviation.compositeScore, severity: deviation.severity, evidence: deviation.evidence },
    recentFeedbackContext: [],
  };
  const reasoning = await options.reasoningService.explain(reasoningInput);

  let notification: { delivered: boolean; reason?: string } | undefined;
  if (options.notificationService) {
    const digest: DigestNotification = {
      householdId: options.householdId,
      severity: reasoning.severityLabel,
      explanation: reasoning.explanation,
      recommendedWording: reasoning.recommendedWording,
      notifyRecommended: reasoning.notifyRecommended,
    };
    notification = await options.notificationService.send(digest);
  }
  return { householdId: options.householdId, baseline, deviation, reasoning, notification };
}
