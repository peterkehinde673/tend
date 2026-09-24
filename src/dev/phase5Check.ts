import { HouseholdSimulator } from '../ingestion/simulator';
import { runAnalysis } from '../analysis/analysisWorker';
import { InMemoryEventStore } from '../store/inMemoryEventStore';
import { TemplateReasoningService } from '../reasoning/templateReasoningService';
import { DEFAULT_CONFIG } from '../config/config';

const TODAY = new Date('2026-09-14T00:00:00.000Z');
const AS_OF = new Date('2026-09-14T09:00:00.000Z');
const HOUSEHOLD_ID = 'phase5-check';
const scenarios = ['normal', 'deviation_missing', 'variable_normal', 'sequence_deviation'] as const;

type Scenario = (typeof scenarios)[number];

async function seedStore(scenario: Scenario): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  const simulator = new HouseholdSimulator({ householdId: HOUSEHOLD_ID, seed: 42 });

  for (const event of simulator.generateHistoricalWindow(TODAY, DEFAULT_CONFIG.defaultWindowDays)) {
    await store.append(event);
  }

  for (const event of simulator.generateDay(TODAY, scenario)) {
    await store.append(event);
  }

  return store;
}

async function checkScenario(scenario: Scenario): Promise<void> {
  const result = await runAnalysis({
    householdId: HOUSEHOLD_ID,
    store: await seedStore(scenario),
    reasoningService: new TemplateReasoningService(),
    today: TODAY,
    asOf: AS_OF,
  });

  if (result.baseline.daysObserved !== DEFAULT_CONFIG.defaultWindowDays) {
    throw new Error(`Expected a ${DEFAULT_CONFIG.defaultWindowDays}-day baseline, got ${result.baseline.daysObserved}`);
  }

  if (result.reasoning.severityLabel !== result.deviation.severity) {
    throw new Error(`Reasoning severity mismatch: ${result.reasoning.severityLabel} != ${result.deviation.severity}`);
  }

  if (scenario === 'normal' && result.deviation.severity !== 'NORMAL') {
    throw new Error(`Normal scenario unexpectedly classified as ${result.deviation.severity}`);
  }

  if (scenario === 'deviation_missing' && result.deviation.presenceDeviation <= 0) {
    throw new Error('Missing-activity scenario produced no presence deviation');
  }

  if (scenario === 'variable_normal' && result.deviation.presenceDeviation < 0) {
    throw new Error('Variable-normal scenario produced an invalid presence deviation');
  }

  if (scenario === 'sequence_deviation') {
    if (result.deviation.sequenceDeviation <= 0) {
      throw new Error('Sequence-deviation scenario produced no sequence deviation');
    }
    if (result.deviation.severity === 'NORMAL') {
      throw new Error('Sequence-deviation scenario failed to surface a non-normal severity');
    }
  }

  console.log(
    `${scenario}: severity=${result.deviation.severity} ` +
      `composite=${result.deviation.compositeScore.toFixed(2)} ` +
      `presence=${result.deviation.presenceDeviation.toFixed(2)} ` +
      `timing=${result.deviation.timingDeviation.toFixed(2)} ` +
      `sequence=${result.deviation.sequenceDeviation.toFixed(2)} ` +
      `reasoning=${result.reasoning.severityLabel}`,
  );
}

async function main(): Promise<void> {
  console.log('=== Phase 5 integration check (local, deterministic) ===');
  for (const scenario of scenarios) {
    await checkScenario(scenario);
  }
  console.log(`PASS: ${scenarios.length} scenarios completed with deterministic severity/reasoning alignment.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
