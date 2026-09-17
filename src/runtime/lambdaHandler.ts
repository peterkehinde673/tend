import { APIGatewayProxyResultV2 } from './types';
import { createEventStore } from '../store/eventStoreFactory';
import { handleRingWebhook, verifyRingSignature } from '../ingestion/ring/ringWebhookHandler';
import { BedrockClient } from '../reasoning/bedrock/bedrockClient';
import { loadBedrockConfig } from '../reasoning/bedrock/bedrockConfig';
import { BedrockModelInvoker } from '../reasoning/bedrock/bedrockReasoner';
import { BedrockReasoningService } from '../reasoning/bedrockReasoningService';
import { FallbackReasoningService } from '../reasoning/fallbackReasoningService';
import { TemplateReasoningService } from '../reasoning/templateReasoningService';
import { runAnalysis } from '../analysis/analysisWorker';
import { createSensitivityStore } from '../feedback/sensitivityStoreFactory';
import { applyPersistentFeedback } from '../feedback/persistentFeedback';
import { FeedbackEvent, isFeedbackType } from '../domain/feedback';
import { NotificationService } from '../notification/notificationService';
import { SnsNotificationService } from '../notification/snsNotificationService';

interface LambdaEvent {
  requestContext?: { http?: { method?: string; path?: string } };
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  source?: string;
  detail?: { householdId?: string; asOf?: string };
}

/** Production entry point for Ring ingestion, caregiver feedback, and scheduled analysis. */
export async function handler(event: LambdaEvent): Promise<APIGatewayProxyResultV2 | { status: string; householdId: string; severity: string }> {
  if (event.requestContext?.http) return handleHttpEvent(event);
  return handleScheduledEvent(event);
}

async function handleHttpEvent(event: LambdaEvent): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext?.http?.method ?? '';
  const path = event.requestContext?.http?.path ?? '';
  if (method === 'GET' && path === '/health') {
    return jsonResponse(200, { status: 'ok', service: 'tend-runtime', eventStore: process.env.EVENT_STORE ?? 'in_memory' });
  }
  if (method !== 'POST' || !['/webhooks/ring', '/feedback'].includes(path)) return jsonResponse(404, { error: 'Not found' });
  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  const signature = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'x-signature')?.[1];
  if (path === '/webhooks/ring') {
    const result = await handleRingWebhook(rawBody, signature, createEventStore(), {
      householdId: process.env.RING_HOUSEHOLD_ID ?? 'ring-household-1',
      source: process.env.RING_EVENT_SOURCE === 'ring_playground' ? 'ring_playground' : 'ring_real',
      hmacSecret: process.env.RING_WEBHOOK_HMAC_SECRET,
    });
    return jsonResponse(result.status, result.body);
  }
  return handleFeedbackHttp(rawBody, signature);
}

async function handleFeedbackHttp(rawBody: string, signature: string | undefined): Promise<APIGatewayProxyResultV2> {
  const secret = process.env.RING_WEBHOOK_HMAC_SECRET;
  if (!secret) return jsonResponse(501, { accepted: false, reason: 'Feedback authentication is not configured.' });
  if (Buffer.byteLength(rawBody, 'utf8') > 64 * 1024) return jsonResponse(413, { accepted: false, reason: 'Request body too large.' });
  if (!verifyRingSignature(rawBody, signature, secret)) return jsonResponse(401, { accepted: false, reason: 'Invalid feedback signature.' });
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return jsonResponse(400, { accepted: false, reason: 'Request body is not valid JSON.' }); }
  if (!parsed || typeof parsed !== 'object') return jsonResponse(400, { accepted: false, reason: 'Feedback payload must be an object.' });
  const payload = parsed as Partial<FeedbackEvent>;
  const householdId = payload.householdId ?? process.env.RING_HOUSEHOLD_ID ?? 'ring-household-1';
  if (!payload.deviationId || typeof payload.deviationId !== 'string' || !isFeedbackType(payload.feedbackType) || !Array.isArray(payload.affectedSignals) || payload.affectedSignals.length === 0 || payload.affectedSignals.some((s) => typeof s !== 'string' || s.length === 0) || !payload.timestamp || Number.isNaN(Date.parse(payload.timestamp))) return jsonResponse(400, { accepted: false, reason: 'Invalid feedback payload.' });
  const feedback: FeedbackEvent = { householdId, deviationId: payload.deviationId, feedbackType: payload.feedbackType, affectedSignals: payload.affectedSignals, timestamp: payload.timestamp };
  const updated = await applyPersistentFeedback(createSensitivityStore(), feedback);
  return jsonResponse(200, { accepted: true, updatedSignals: updated.map((item) => ({ signal: item.signal, multiplier: item.multiplier, lastUpdatedAt: item.lastUpdatedAt })) });
}

async function handleScheduledEvent(event: LambdaEvent): Promise<{ status: string; householdId: string; severity: string }> {
  const householdId = event.detail?.householdId ?? process.env.RING_HOUSEHOLD_ID ?? 'ring-household-1';
  const asOf = event.detail?.asOf ? new Date(event.detail.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) throw new Error('Invalid scheduled analysis asOf timestamp.');
  const today = new Date(asOf);
  today.setUTCHours(0, 0, 0, 0);
  const notificationService = createNotificationService();
  const result = await runAnalysis({ householdId, store: createEventStore(), sensitivityStore: createSensitivityStore(), reasoningService: buildReasoningService(), notificationService, today, asOf });
  console.log(JSON.stringify({ status: 'analysis_complete', householdId, severity: result.deviation.severity, notifyRecommended: result.reasoning.notifyRecommended, notificationDelivered: result.notification?.delivered ?? false }));
  return { status: 'analysis_complete', householdId, severity: result.deviation.severity };
}

function createNotificationService(): NotificationService | undefined {
  const topicArn = process.env.TEND_SNS_TOPIC_ARN;
  return topicArn ? new SnsNotificationService(topicArn) : undefined;
}

function buildReasoningService(): import('../reasoning/contract').ReasoningService {
  const template = new TemplateReasoningService();
  if (!process.env.AWS_REGION || !process.env.BEDROCK_MODEL_ID) return template;
  const config = loadBedrockConfig();
  const bedrock = new BedrockReasoningService(new BedrockModelInvoker(new BedrockClient(config)));
  return new FallbackReasoningService(bedrock, template, () => console.warn('Tend Bedrock reasoning failed; template fallback used.'));
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) };
}
