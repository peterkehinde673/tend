import { FeedbackEvent, SignalSensitivity } from '../domain/feedback';
import { DEFAULT_CONFIG, TendConfig } from '../config/config';
import { SensitivityStore as LegacySensitivityStore, applyFeedback } from './feedbackEngine';
import { SensitivityStore } from './sensitivityStore';

/**
 * Applies the existing conservative feedback algorithm while loading and
 * persisting each affected signal through the storage boundary. The
 * algorithm itself is intentionally unchanged from the local demo path.
 */
export async function applyPersistentFeedback(
  store: SensitivityStore,
  feedback: FeedbackEvent,
  config: TendConfig = DEFAULT_CONFIG,
): Promise<SignalSensitivity[]> {
  const claimed = await store.claimFeedback(feedback);
  if (!claimed) return [];

  const results: SignalSensitivity[] = [];

  for (const signal of feedback.affectedSignals) {
    const persisted = await store.get(feedback.householdId, signal, config);

    // Reuse the battle-tested synchronous algorithm against exactly one
    // hydrated signal. This avoids creating a second feedback algorithm
    // whose behavior could drift from the local/demo implementation.
    const working = new LegacySensitivityStore();
    working.set(persisted);
    const [updated] = applyFeedback(working, { ...feedback, affectedSignals: [signal] }, config);

    await store.put(updated);
    results.push(updated);
  }

  return results;
}
