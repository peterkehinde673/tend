/**
 * Provider-independent notification abstraction. The goal is exactly the
 * boundary requested for this phase: `analysis result -> notification
 * abstraction`, so a real provider (SNS, email, push) can be added later
 * without coupling the domain/analysis code to AWS or any specific
 * provider. Only one implementation exists in this phase
 * (ConsoleNotificationService) — this project does not add multiple
 * notification providers speculatively.
 */

export interface DigestNotification {
  householdId: string;
  /** Mirrors ReasoningOutput.severityLabel — never a separately-decided value. */
  severity: string;
  /** The reasoning layer's plain-language explanation. Never raw evidence or raw Ring data. */
  explanation: string;
  recommendedWording: string;
  notifyRecommended: boolean;
}

export interface NotificationService {
  send(notification: DigestNotification): Promise<{ delivered: boolean; reason?: string }>;
}

/**
 * Safe local default: prints a notification to the console. Never used to
 * fake a "real" delivery — the returned `delivered: true` only means "this
 * process printed it," which is the honest scope of what a console
 * notifier can promise. Never logs anything beyond the fields already
 * present on DigestNotification (which themselves derive entirely from
 * the reasoning layer's structured output, never raw Ring payloads).
 */
export class ConsoleNotificationService implements NotificationService {
  async send(notification: DigestNotification): Promise<{ delivered: boolean; reason?: string }> {
    if (!notification.notifyRecommended) {
      // Honor the reasoning layer's own recommendation not to notify —
      // this is intentionally a no-op, not a silent failure.
      return { delivered: false, reason: 'notifyRecommended was false; no notification sent by design.' };
    }

    // eslint-disable-next-line no-console
    console.log(
      `[Tend notification] household=${notification.householdId} severity=${notification.severity} — ${notification.explanation} (${notification.recommendedWording})`,
    );
    return { delivered: true };
  }
}
