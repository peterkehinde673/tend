/* eslint-disable no-console */
/**
 * `npm run analysis:check` — exercises the Phase 4 analysis worker
 * end-to-end against the in-memory event store and simulator, proving the
 * full pipeline (persistence -> deterministic engine -> reasoning ->
 * notification) works without any AWS/Ring credentials.
 */
import { HouseholdSimulator, ScenarioName, SCENARIO_NAMES } from '../ingestion/simulator';
import { InMemoryEventStore } from '../store/inMemoryEventStore';
import { runAnalysis } from '../analysis/analysisWorker';
import { TemplateReasoningService } from '../reasoning/templateReasoningService';
import { ConsoleNotificationService } from '../notification/notificationService';

async function main(): Promise<void> {
  const scenarioArg = process.argv[2] as ScenarioName | undefined;
  const scenario: ScenarioName = scenarioArg && (SCENARIO_NAMES as string[]).includes(scenarioArg) ? scenarioArg : 'sequence_deviation';

  const householdId = 'analysis-check-household';
  const today = new Date('2026-09-14T00:00:00.000Z');
  const asOf = new Date('2026-09-14T09:00:00.000Z');

  const store = new InMemoryEventStore();
  const sim = new HouseholdSimulator({ householdId, seed: 42 });
  for (const event of sim.generateHistoricalWindow(today, 14)) await store.append(event);
  for (const event of sim.generateDay(today, scenario)) await store.append(event);

  console.log(`=== Analysis worker check (scenario: ${scenario}, EventStore: in-memory) ===\n`);

  const result = await runAnalysis({
    householdId,
    store,
    reasoningService: new TemplateReasoningService(),
    notificationService: new ConsoleNotificationService(),
    today,
    asOf,
  });

  console.log(`Baseline: ${result.baseline.daysObserved} days observed, confidence ${result.baseline.confidence.toFixed(2)}`);
  console.log(`Deviation: composite=${result.deviation.compositeScore.toFixed(2)} severity=${result.deviation.severity}`);
  console.log(`Reasoning: ${JSON.stringify(result.reasoning, null, 2)}`);
  console.log(`Notification result: ${JSON.stringify(result.notification)}`);
}

main().catch((err) => {
  console.error('Analysis worker check failed:', (err as Error).message);
  process.exitCode = 1;
});
