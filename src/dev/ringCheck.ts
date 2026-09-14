/* eslint-disable no-console */
/**
 * `npm run ring:check` — the minimal, honest runtime proof that this
 * application actually calls the Ring API, as required by the hackathon's
 * "Ring technology must be imported/called at runtime" rule.
 *
 * This script does NOT fake success. If RING_ACCESS_TOKEN (and
 * RING_EVENT_SOURCE) are not configured, it says exactly that and exits
 * non-zero. If they are configured but the network call fails (including
 * failure caused by this environment's own egress restrictions, which is
 * the expected outcome in the sandboxed development environment this
 * project was built in), it reports the real error — never a fabricated
 * success message.
 */
import { tryLoadRingConfig } from '../ingestion/ring/ringConfig';
import { RingEventSource } from '../ingestion/ring/ringEventSource';

async function main(): Promise<void> {
  console.log('Tend Ring integration check');

  const loaded = tryLoadRingConfig();
  if ('error' in loaded) {
    console.log(`Authentication: NOT CONFIGURED — ${loaded.error}`);
    console.log('No Ring API call was attempted.');
    process.exitCode = 1;
    return;
  }

  const { config } = loaded;
  console.log(`Source: ${config.source}`);
  console.log(`API base URL: ${config.apiBaseUrl}`);
  console.log('Authentication: token present (value never printed)');

  const ringSource = new RingEventSource(config);

  const connection = await ringSource.checkConnection();
  if (!connection.ok) {
    console.log('Ring API: UNREACHABLE or call failed');
    console.log(`Reason: ${connection.error}`);
    console.log('User: unavailable');
    console.log('Devices discovered: 0 (skipped — connection check failed)');
    console.log('No credentials displayed.');
    process.exitCode = 1;
    return;
  }

  console.log('Ring API: reachable');
  console.log('User: available');

  try {
    const devices = await ringSource.discoverDevices();
    console.log(`Devices discovered: ${devices.length}`);
    const unparsedCount = devices.filter((d) => d.unparsed).length;
    if (unparsedCount > 0) {
      console.log(`(${unparsedCount} device entr${unparsedCount === 1 ? 'y' : 'ies'} had an unrecognized shape and could not be summarized — see ringTypes.ts for why device response shape is treated as unconfirmed.)`);
    }
  } catch (err) {
    console.log('Devices discovered: unknown — device discovery call failed');
    console.log(`Reason: ${(err as Error).message}`);
  }

  console.log('No credentials displayed.');
}

main().catch((err) => {
  console.error('Ring check failed with an unexpected error:', (err as Error).message);
  process.exitCode = 1;
});
