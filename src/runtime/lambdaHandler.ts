import { APIGatewayProxyResultV2 } from './types';
import { createEventStore } from '../store/eventStoreFactory';
import { handleRingWebhook } from '../ingestion/ring/ringWebhookHandler';
import { BedrockClient } from '../reasoning/bedrock/bedrockClient';
import { loadBedrockConfig } from '../reasoning/bedrock/bedrockConfig';
import { BedrockModelInvoker } from '../reasoning/bedrock/bedrockReasoner';
import { BedrockReasoningService } from '../reasoning/bedrockReasoningService';
import { FallbackReasoningService } from '../reasoning/fallbackReasoningService';
import { TemplateReasoningService } from '../reasoning/templateReasoningService';
import { runAnalysis } from '../analysis/analysisWorker';

interface LambdaEvent {
  requestContext?: { http?: { method?: string; path?: string } };
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  source?: string;
  detail?: { householdId?: string; asOf?: string };
}

/**
 * Production entry point for the AWS runtime.
 *
 * HTTP: API Gateway -> Ring webhook verification -> EventStore.
 * Scheduled: EventBridge Scheduler -> bounded analysis worker -> Bedrock
 * reasoning (with the existing deterministic template fallback).
 *
 * This is deliberately thin: the security and domain decisions remain in
 * the existing application services so the local server and AWS runtime
 * exercise the same code paths.
 */
export async function handler(event: LambdaEvent): Promise<APIGatewayProxyResultV2 | { status: string; householdId: string; severity: string }> {
  if (event.requestContext?.http) {
    return handleHttpEvent(event);
  }

  return handleScheduledEvent(event);
}

async function handleHttpEvent(event: LambdaEvent): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext?.http?.method ?? '';
  const path = event.requestContext?.http?.path ?? '';

  if (method !== 'POST' || path !== '/webhooks/ring') {
    return jsonResponse(404, { error: 'Not found' });
  }

  const rawBody = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : '';

  const headers = event.headers ?? {};
  const signature = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-signature')?.[1];

  const store = createEventStore();
  const result = await handleRingWebhook(rawBody, signature, store, {
    householdId: process.env.RING_HOUSEHOLD_ID ?? 'ring-household-1',
    source: process.env.RING_EVENT_SOURCE === 'ring_playground' ? 'ring_playground' : 'ring_real',
    hmacSecret: process.env.RING_WEBHOOK_HMAC_SECRET,
  });

  return jsonResponse(result.status, result.body);
}

async function handleScheduledEvent(event: LambdaEvent): Promise<{ status: string; householdId: string; severity: string }> {
  const householdId = event.detail?.householdId ?? process.env.RING_HOUSEHOLD_ID ?? 'ring-household-1';
  const asOf = event.detail?.asOf ? new Date(event.detail.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new Error('Invalid scheduled analysis asOf timestamp.');
  }

  const today = new Date(asOf);
  today.setUTCHours(0, 0, 0, 0);

  const store = createEventStore();
  const template = new TemplateReasoningService();
  let reasoningService = template as import('../reasoning/contract').ReasoningService;

  if (process.env.AWS_REGION && process.env.BEDROCK_MODEL_ID) {
    const config = loadBedrockConfig();
    const bedrock = new BedrockReasoningService(new BedrockModelInvoker(new BedrockClient(config)));
    reasoningService = new FallbackReasoningService(bedrock, template, () => {
      // Safe operational marker only; never include household evidence or
      // model payloads in logs.
      console.warn('Tend Bedrock reasoning failed; template fallback used.');
    });
  }

  const result = await runAnalysis({
    householdId,
    store,
    reasoningService,
    today,
    asOf,
  });

  // Notification delivery remains behind the existing NotificationService
  // abstraction. Phase 5 deliberately does not invent an external provider.
  console.log(JSON.stringify({
    status: 'analysis_complete',
    householdId,
    severity: result.deviation.severity,
    notifyRecommended: result.reasoning.notifyRecommended,
  }));

  return { status: 'analysis_complete', householdId, severity: result.deviation.severity };
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
