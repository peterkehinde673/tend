/* eslint-disable no-console */
/**
 * `npm run bedrock:check` — the minimal, honest runtime proof of whether
 * this application can actually call Bedrock, mirroring `ring:check`'s
 * approach exactly.
 *
 * Does NOT fake success. If AWS_REGION/BEDROCK_MODEL_ID are missing, says
 * so and exits non-zero without attempting anything. If they're present,
 * attempts a real, minimal Bedrock Converse call and reports the actual
 * result — including the expected failure in this sandboxed environment
 * (the AWS SDK package cannot be installed here; see README).
 */
import { tryLoadBedrockConfig } from '../reasoning/bedrock/bedrockConfig';
import { BedrockClient } from '../reasoning/bedrock/bedrockClient';

async function main(): Promise<void> {
  console.log('Tend Bedrock integration check');

  const loaded = tryLoadBedrockConfig();
  if ('error' in loaded) {
    console.log(`Configuration: NOT CONFIGURED — ${loaded.error}`);
    console.log('No Bedrock call was attempted.');
    process.exitCode = 1;
    return;
  }

  const { config } = loaded;
  console.log(`Region: ${config.region}`);
  console.log(`Model ID: ${config.modelId}`);
  console.log('Attempting a minimal real Bedrock Converse call...');

  const client = new BedrockClient(config);
  try {
    // A minimal, non-sensitive smoke-test prompt — deliberately not a real
    // ReasoningInput payload, since this command's only purpose is proving
    // connectivity/credentials/model access, not exercising the reasoning
    // contract (see the mocked tests in test/bedrock/ for that).
    const text = await client.converse(
      'Reply with exactly the single word: OK',
      'Respond with exactly the single word OK and nothing else.',
    );
    console.log('Bedrock API: REACHABLE');
    console.log(`Response received: ${text.length} character(s) (content not printed — this is a connectivity check, not a content check).`);
  } catch (err) {
    console.log('Bedrock API: UNREACHABLE or call failed');
    console.log(`Reason: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
}

main().catch((err) => {
  console.error('Bedrock check failed with an unexpected error:', (err as Error).message);
  process.exitCode = 1;
});
