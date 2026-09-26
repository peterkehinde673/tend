import { SignalSensitivity } from '../domain/feedback';
import { TendConfig } from '../config/config';

/**
 * Persistence boundary for caregiver-adjusted signal sensitivity.
 * The feedback algorithm remains independent of the storage backend.
 */
export interface SensitivityStore {
  get(householdId: string, signal: string, config?: TendConfig): Promise<SignalSensitivity>;
  put(sensitivity: SignalSensitivity): Promise<void>;
}
