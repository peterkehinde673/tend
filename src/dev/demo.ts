/* eslint-disable no-console */
import { DemoState } from './demoState';
import { ScenarioName, SCENARIO_NAMES } from '../ingestion/simulator';

async function main(): Promise<void> {
  const scenarioArg = process.argv[2] as ScenarioName | undefined;
  const scenario: ScenarioName =
    scenarioArg && (SCENARIO_NAMES as string[]).includes(scenarioArg) ? scenarioArg : 'deviation_missing';

  // Fixed "today" so demo output is reproducible run to run.
  const today = new Date('2026-09-14T00:00:00.000Z'); // a Monday
  const asOf = new Date('2026-09-14T09:00:00.000Z'); // 09:00 — well past the morning routine window

  const state = new DemoState();
  await state.ensureSeeded(today);
  await state.setScenario(scenario, today);
  const snapshot = await state.snapshot(today, asOf);

  console.log('=== Tend Development Demo (dev_simulator source — NOT real Ring data) ===\n');
  console.log(`Household: ${state.householdId}`);
  console.log(`Scenario: ${snapshot.scenario}`);
  console.log(`Evaluated date: ${snapshot.deviation.evaluatedDate}, as-of: ${asOf.toISOString()}\n`);

  console.log(`Baseline: ${snapshot.baseline.daysObserved} days observed, confidence ${snapshot.baseline.confidence.toFixed(2)}\n`);

  console.log('--- Deterministic Deviation Result ---');
  console.log(`Composite score: ${snapshot.deviation.compositeScore.toFixed(2)}`);
  console.log(`Severity: ${snapshot.deviation.severity}`);
  console.log(`presenceDeviation=${snapshot.deviation.presenceDeviation.toFixed(2)} timingDeviation=${snapshot.deviation.timingDeviation.toFixed(2)} sequenceDeviation=${snapshot.deviation.sequenceDeviation.toFixed(2)}`);
  console.log('Evidence:');
  for (const e of snapshot.deviation.evidence) {
    console.log(`  - ${JSON.stringify(e)}`);
  }

  console.log('\n--- Reasoning Layer Output (TemplateReasoningService — NOT live Bedrock) ---');
  console.log(JSON.stringify(snapshot.reasoning, null, 2));

  console.log('\n--- Recent Events (source tagged) ---');
  for (const e of snapshot.recentEvents.slice(-8)) {
    console.log(`  [${e.source}] ${e.occurredAt} ${e.zoneId ?? e.deviceId} ${e.eventType}${e.subType ? '/' + e.subType : ''}`);
  }

  console.log('\n--- Simulating caregiver feedback: "expected" ---');
  await state.submitFeedback('demo-deviation-1', 'expected', snapshot.deviation.evidence.map((e) => e.signal), asOf.toISOString());
  const after = await state.snapshot(today, asOf);
  console.log('Sensitivities after feedback:', JSON.stringify(after.sensitivities, null, 2));
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exitCode = 1;
});
