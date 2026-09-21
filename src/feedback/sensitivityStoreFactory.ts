import { SensitivityStore } from './sensitivityStore';
import { DynamoSensitivityStore } from './dynamoSensitivityStore';
import { loadDynamoEventStoreConfig } from '../store/dynamoConfig';

/** Select persistent feedback storage from the same runtime switch as events. */
export function createSensitivityStore(): SensitivityStore {
  const backend = process.env.EVENT_STORE ?? 'in_memory';
  if (backend === 'in_memory') return new InMemorySensitivityStore();
  if (backend === 'dynamodb') return new DynamoSensitivityStore(loadDynamoEventStoreConfig());
  throw new Error(`Unsupported EVENT_STORE backend: ${backend}`);
}

/** Small in-memory implementation used by tests and local development. */
export class InMemorySensitivityStore implements SensitivityStore {
  private readonly state = new Map<string, import('../domain/feedback').SignalSensitivity>();
  private readonly claimedFeedback = new Set<string>();

  async claimFeedback(feedback: import('../domain/feedback').FeedbackEvent): Promise<boolean> {
    const key = JSON.stringify({ householdId: feedback.householdId, deviationId: feedback.deviationId, feedbackType: feedback.feedbackType, affectedSignals: [...feedback.affectedSignals].sort(), timestamp: feedback.timestamp });
    if (this.claimedFeedback.has(key)) return false;
    this.claimedFeedback.add(key);
    return true;
  }

  async get(householdId: string, signal: string, config?: import('../config/config').TendConfig) {
    const key = `${householdId}::${signal}`;
    const existing = this.state.get(key);
    if (existing) return existing;
    const fresh = {
      householdId,
      signal,
      multiplier: config?.feedback.defaultMultiplier ?? 1,
      lastUpdatedAt: new Date(0).toISOString(),
      recentFeedback: [],
    };
    this.state.set(key, fresh);
    return fresh;
  }

  async put(sensitivity: import('../domain/feedback').SignalSensitivity): Promise<void> {
    this.state.set(`${sensitivity.householdId}::${sensitivity.signal}`, sensitivity);
  }
}
