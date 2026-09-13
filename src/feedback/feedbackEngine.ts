import { FeedbackEvent, SignalSensitivity } from '../domain/feedback';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';

/**
 * In-memory store for per-(household, signal) sensitivity state. Kept
 * separate from the event/baseline stores since it has a distinct lifecycle
 * and update model. A DynamoDB-backed implementation can replace this later
 * behind the same shape without touching the update logic below.
 */
export class SensitivityStore {
  private readonly state: Map<string, SignalSensitivity> = new Map();

  private key(householdId: string, signal: string): string {
    return `${householdId}::${signal}`;
  }

  get(householdId: string, signal: string, config: TendConfig = DEFAULT_CONFIG): SignalSensitivity {
    const key = this.key(householdId, signal);
    const existing = this.state.get(key);
    if (existing) return existing;

    const fresh: SignalSensitivity = {
      householdId,
      signal,
      multiplier: config.feedback.defaultMultiplier,
      lastUpdatedAt: new Date(0).toISOString(),
      recentFeedback: [],
    };
    this.state.set(key, fresh);
    return fresh;
  }

  set(sensitivity: SignalSensitivity): void {
    this.state.set(this.key(sensitivity.householdId, sensitivity.signal), sensitivity);
  }

  all(): SignalSensitivity[] {
    return [...this.state.values()];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.abs(Date.parse(aIso) - Date.parse(bIso)) / (24 * 60 * 60 * 1000);
}

/**
 * Applies decay toward the default multiplier (1.0) based on elapsed time
 * since the last update, using a simple half-life model:
 *   distanceFromDefault(t) = distanceFromDefault(0) * 0.5^(t / halfLife)
 * This is what keeps a stale "not_useful" nudge from permanently silencing
 * a signal — see Task 7 in the approved architecture.
 */
function applyDecay(multiplier: number, daysElapsed: number, config: TendConfig): number {
  const distance = multiplier - config.feedback.defaultMultiplier;
  const halfLives = daysElapsed / config.feedback.decayHalfLifeDays;
  const decayed = distance * Math.pow(0.5, halfLives);
  return config.feedback.defaultMultiplier + decayed;
}

/**
 * Counts how many feedback events of the SAME type, for the SAME signal,
 * fall within the corroboration window (excluding the brand-new one being
 * processed, which is passed in separately by the caller).
 */
function countCorroboratingFeedback(
  recentFeedback: FeedbackEvent[],
  feedbackType: FeedbackEvent['feedbackType'],
  nowIso: string,
  config: TendConfig,
): number {
  return recentFeedback.filter(
    (f) => f.feedbackType === feedbackType && daysBetween(f.timestamp, nowIso) <= config.feedback.corroborationWindowDays,
  ).length;
}

const MAX_RECENT_FEEDBACK_KEPT = 20;

/**
 * Applies one caregiver feedback event to the sensitivity state for every
 * signal it names, and returns the updated states. This function embodies
 * the conservative update rule:
 *  - "keep_watching" is always a pure no-op on the multiplier (logged only).
 *  - The FIRST event of a given (signal, feedbackType) combination only
 *    ever applies a minimal nudge, bounded by the configured step.
 *  - A larger cumulative effect requires `corroborationCountRequired`
 *    matching events within `corroborationWindowDays` — this is what
 *    prevents one mistaken click from corrupting the model.
 *  - Every multiplier stays within [minMultiplier, maxMultiplier].
 *  - Time-based decay toward the default (1.0) is applied before the new
 *    nudge, so long-stale adjustments fade on their own.
 */
export function applyFeedback(
  store: SensitivityStore,
  feedback: FeedbackEvent,
  config: TendConfig = DEFAULT_CONFIG,
): SignalSensitivity[] {
  const results: SignalSensitivity[] = [];

  for (const signal of feedback.affectedSignals) {
    const current = store.get(feedback.householdId, signal, config);

    const daysSinceUpdate = daysBetween(current.lastUpdatedAt, feedback.timestamp);
    const decayedMultiplier = applyDecay(current.multiplier, daysSinceUpdate, config);

    let nudge = 0;
    if (feedback.feedbackType === 'keep_watching') {
      nudge = 0; // explicit no-op, per the approved design
    } else {
      const corroborationCount = countCorroboratingFeedback(
        current.recentFeedback,
        feedback.feedbackType,
        feedback.timestamp,
        config,
      );
      // The very first occurrence always applies only the minimal step.
      // Reaching the required corroboration count allows one additional
      // step on top — deliberately not a multiplying/compounding effect,
      // so repeated feedback moves the needle gradually rather than
      // snapping to an extreme value.
      const isCorroborated = corroborationCount + 1 >= config.feedback.corroborationCountRequired;
      const steps = isCorroborated ? 2 : 1;

      if (feedback.feedbackType === 'expected' || feedback.feedbackType === 'not_useful') {
        nudge = config.feedback.nudgeStep * steps; // less sensitive -> higher threshold multiplier
      } else if (feedback.feedbackType === 'unusual') {
        nudge = -config.feedback.nudgeStep * steps; // more sensitive -> lower threshold multiplier
      }
    }

    const newMultiplier = clamp(decayedMultiplier + nudge, config.feedback.minMultiplier, config.feedback.maxMultiplier);

    const recentFeedback = [feedback, ...current.recentFeedback].slice(0, MAX_RECENT_FEEDBACK_KEPT);

    const updated: SignalSensitivity = {
      householdId: feedback.householdId,
      signal,
      multiplier: newMultiplier,
      lastUpdatedAt: feedback.timestamp,
      recentFeedback,
    };

    store.set(updated);
    results.push(updated);
  }

  return results;
}
