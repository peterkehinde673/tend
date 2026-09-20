import { DigestNotification, NotificationService } from './notificationService';

/**
 * AWS notification adapter. Delivery is opt-in: when no topic ARN is
 * configured, the existing no-op behavior remains intact.
 */
export class SnsNotificationService implements NotificationService {
  constructor(
    private readonly topicArn: string,
    private readonly moduleLoader: () => Promise<SnsModules> = loadSnsModules,
  ) {}

  async send(notification: DigestNotification): Promise<{ delivered: boolean; reason?: string }> {
    if (!notification.notifyRecommended) {
      return { delivered: false, reason: 'notifyRecommended was false; no notification sent by design.' };
    }
    if (!this.topicArn) return { delivered: false, reason: 'SNS topic is not configured.' };
    const sdk = await this.moduleLoader();
    const client = new sdk.SNSClient({});
    await client.send(new sdk.PublishCommand({
      TopicArn: this.topicArn,
      Subject: `Tend routine update: ${notification.severity}`,
      Message: JSON.stringify({
        householdId: notification.householdId,
        severity: notification.severity,
        explanation: notification.explanation,
        recommendedWording: notification.recommendedWording,
        notifyRecommended: notification.notifyRecommended,
      }),
    }));
    return { delivered: true };
  }
}

export interface SnsModules {
  SNSClient: new (opts: Record<string, unknown>) => SnsClient;
  PublishCommand: new (input: Record<string, unknown>) => unknown;
}

interface SnsClient {
  send: (command: unknown) => Promise<unknown>;
}

async function loadSnsModules(): Promise<SnsModules> {
  try {
    const moduleName = '@aws-sdk/client-sns';
    const mod = await import(moduleName) as {
      SNSClient: SnsModules['SNSClient'];
      PublishCommand: SnsModules['PublishCommand'];
    };
    return mod;
  } catch (err) {
    throw new Error(`Could not load SNS SDK: ${(err as Error).message}`);
  }
}
