import { EventStore } from '../store/eventStore';
import { buildHouseholdBaseline } from '../engine/baselineEngine';
import { evaluateDeviation } from '../engine/deviationEngine';
import { HouseholdBaseline } from '../domain/baseline';
import { DeviationResult } from '../domain/deviation';
import { ReasoningInput, ReasoningOutput, ReasoningService } from '../reasoning/contract';
import { NotificationService, DigestNotification } from '../notification/notificationService';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';

/**
 * The application/service boundary for the AWS-native target described in
 * the architecture:
 *
 *   EventBridge Scheduler -> analysis worker -> persistent event store ->
 *   deterministic baseline/deviation engine -> structured evidence ->
 *   Bedrock reasoning -> digest/notification abstraction
 *
 * This phase implements the worker itself (this file) — the actual
 * Scheduler/Lambda deployment wiring is intentionally NOT built here, per
 * the instruction to avoid overbuilding infrastructure. `runAnalysis`
 * below is exactly the function a Lambda handler (or a cron job, or a
 * manual CLI invocation) would call; wiring it behind EventBridge
 * Scheduler + Lambda is deployment configuration, not application logic,
 * and is left for the actual deployment phase — see README "Scheduled
 * Analysis" for what remains.
 *
 * ARCHITECTURAL GUARANTEE: this worker calls the deterministic engine
 * (buildHouseholdBaseline, evaluateDeviation — both unchanged from Phase 1)
 * BEFORE it ever touches the reasoning service. The reasoning service only
 * ever receives the already-computed DeviationResult's evidence — it is
 * structurally incapable of deciding whether an anomaly exists, since that
 * decision has already been made by the time reasoning is invoked.
 */

export interface AnalysisWorkerOptions {
  householdId: string;
  store: EventStore;
  reasoningService: ReasoningService;
  /** Optional — if provided, the worker also attempts to send a notification for the result. Never required; a worker with no notificationService just returns the analysis. */
  notificationService?: NotificationService;
  /** "Today" for baseline/deviation purposes — the calendar day being evaluated. */
  today: Date;
  /** The point in time within `today` to evaluate as-of (e.g. "now"). */
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

  // 1 & 2: load enough historical + recent events for the baseline via a
  // single bounded time-range query (buildHouseholdBaseline itself excludes
  // events on/after `today`, so this one query safely covers both the
  // baseline window and any partial data for today without a second call).
  const windowStart = new Date(options.today.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const events = await options.store.getByTimeRange({
    householdId: options.householdId,
    fromIso: windowStart.toISOString(),
    toIso: options.asOf.toISOString(),
  });

  // 3: deterministic baseline + deviation — the sole source of truth for
  // whether anything is anomalous. Unchanged engine code from Phase 1.
  const baseline = buildHouseholdBaseline(options.householdId, events, options.today, config, windowDays);
  const todayKey = options.today.toISOString().slice(0, 10);
  const todaysEvents = events.filter((e) => e.occurredAt.startsWith(todayKey));
  const deviation = evaluateDeviation(baseline, todaysEvents, options.today, options.asOf, config);

  // 4 & 5: structured evidence only — never raw events — passed to the
  // existing, unchanged reasoning contract.
  const reasoningInput: ReasoningInput = {
    householdContext: { daysOfBaseline: baseline.daysObserved, confidence: baseline.confidence },
    deviation: { compositeScore: deviation.compositeScore, severity: deviation.severity, evidence: deviation.evidence },
    recentFeedbackContext: [],
  };
  const reasoning = await options.reasoningService.explain(reasoningInput);

  // 6: produce a digest/result, and optionally deliver it.
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
