/**
 * DEVELOPMENT SERVER — NOT PRODUCTION INFRASTRUCTURE.
 *
 * Deliberately built on Node's built-in `http` module rather than Express:
 * this sandboxed development environment has no npm registry access, so
 * only packages already available locally (Node's standard library,
 * TypeScript, ts-node) can be used. Before real deployment, this should be
 * replaced by (or fronted by) API Gateway + Lambda per the approved AWS
 * architecture — this server exists solely to let a human click through the
 * engine locally and to give the CLI demo a browsable counterpart.
 *
 * Endpoints:
 *   GET /health          -> liveness check
 *   GET /demo            -> full snapshot (baseline + deviation + reasoning + events), same data the CLI prints
 *   GET /events          -> recent normalized events (source-tagged)
 *   GET /baseline        -> the current household baseline
 *   GET /deviation       -> the current deviation result
 *   GET /reasoning       -> the current reasoning-layer output
 *   POST /scenario       -> { "scenario": "normal" | "deviation_missing" | "variable_normal" | "sequence_deviation" } — regenerates "today"
 *   POST /feedback       -> { "feedbackType": "expected" | "not_useful" | "keep_watching" | "unusual", "signals": string[] }
 *   POST /webhooks/ring  -> Ring Partner API webhook receiver (see ringWebhookHandler.ts). Stores into a SEPARATE
 *                           event store from the simulator/demo data above — Ring-sourced events never mix with
 *                           simulator-sourced events. Returns 501 unless RING_WEBHOOK_HMAC_SECRET is configured;
 *                           this project has not verified that anything (Playground or otherwise) actually
 *                           delivers webhooks to this route in the current environment — see README.
 */
import * as http from 'node:http';
import { URL } from 'node:url';
import { DemoState } from './demoState';
import { ScenarioName, SCENARIO_NAMES } from '../ingestion/simulator';
import { isFeedbackType } from '../domain/feedback';
import { InMemoryEventStore } from '../store/inMemoryEventStore';
import { handleRingWebhook } from '../ingestion/ring/ringWebhookHandler';
import { TendEventSource } from '../domain/event';

const PORT = Number(process.env.PORT ?? 8787);

const RING_WEBHOOK_HOUSEHOLD_ID = 'ring-household-1';
const ringEventStore = new InMemoryEventStore();

function resolveRingWebhookSource(): Extract<TendEventSource, 'ring_real' | 'ring_playground'> {
  return process.env.RING_EVENT_SOURCE === 'ring_playground' ? 'ring_playground' : 'ring_real';
}

// Fixed demo "today"/"asOf" so the server's output matches the CLI demo
// exactly — see src/dev/demo.ts for the rationale.
const TODAY = new Date('2026-09-14T00:00:00.000Z');
const AS_OF = new Date('2026-09-14T09:00:00.000Z');

const state = new DemoState();

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    // Basic request-size limit: refuse anything absurd for a local dev tool.
    const MAX_BYTES = 64 * 1024;
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'tend-dev-server', note: 'Local development server, not production infrastructure.' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/demo') {
      const snapshot = await state.snapshot(TODAY, AS_OF);
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const snapshot = await state.snapshot(TODAY, AS_OF);
      sendJson(res, 200, { events: snapshot.recentEvents });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/baseline') {
      const snapshot = await state.snapshot(TODAY, AS_OF);
      sendJson(res, 200, snapshot.baseline);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/deviation') {
      const snapshot = await state.snapshot(TODAY, AS_OF);
      sendJson(res, 200, snapshot.deviation);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/reasoning') {
      const snapshot = await state.snapshot(TODAY, AS_OF);
      sendJson(res, 200, snapshot.reasoning);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/scenario') {
      const bodyText = await readRequestBody(req);
      const body = bodyText ? JSON.parse(bodyText) : {};
      const scenario = body.scenario as ScenarioName | undefined;
      if (!scenario || !(SCENARIO_NAMES as string[]).includes(scenario)) {
        sendJson(res, 400, { error: `scenario must be one of: ${SCENARIO_NAMES.join(', ')}` });
        return;
      }
      await state.setScenario(scenario, TODAY);
      const snapshot = await state.snapshot(TODAY, AS_OF);
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/feedback') {
      const bodyText = await readRequestBody(req);
      const body = bodyText ? JSON.parse(bodyText) : {};
      const feedbackType = body.feedbackType;
      const signals = body.signals;
      if (!isFeedbackType(feedbackType)) {
        sendJson(res, 400, { error: 'feedbackType must be one of: expected, not_useful, keep_watching, unusual' });
        return;
      }
      if (!Array.isArray(signals) || signals.some((s) => typeof s !== 'string')) {
        sendJson(res, 400, { error: 'signals must be an array of strings' });
        return;
      }
      await state.submitFeedback('dev-server-deviation', feedbackType, signals, new Date().toISOString());
      sendJson(res, 200, { accepted: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/ring') {
      const rawBody = await readRequestBody(req);
      const signatureHeader = req.headers['x-signature'];
      const result = await handleRingWebhook(
        rawBody,
        Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader,
        ringEventStore,
        {
          householdId: RING_WEBHOOK_HOUSEHOLD_ID,
          source: resolveRingWebhookSource(),
          hmacSecret: process.env.RING_WEBHOOK_HMAC_SECRET,
        },
      );
      sendJson(res, result.status, result.body);
      return;
    }

    sendJson(res, 404, { error: 'Not found', hint: 'GET /health, /demo, /events, /baseline, /deviation, /reasoning; POST /scenario, /feedback, /webhooks/ring' });
  } catch (err) {
    // Never leak stack traces or internals that might include secrets;
    // this dev server holds no secrets today, but keep the habit from day one.
    sendJson(res, 500, { error: 'Internal error', message: (err as Error).message });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Tend dev server (NOT production infrastructure) listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log('All data is from the development simulator (source: dev_simulator) — no real Ring account is connected.');
});
