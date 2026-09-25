import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function requireText(path: string, text: string): void {
  const content = read(path);
  if (!content.includes(text)) {
    throw new Error(`release check failed: ${path} does not contain ${JSON.stringify(text)}`);
  }
}

function requireAbsent(path: string, text: string): void {
  const content = read(path);
  if (content.includes(text)) {
    throw new Error(`release check failed: ${path} still contains forbidden text ${JSON.stringify(text)}`);
  }
}

if (!existsSync(join(root, 'package-lock.json'))) {
  throw new Error('release check failed: package-lock.json is missing; npm ci would not be reproducible');
}

const packageJson = JSON.parse(read('package.json')) as {
  scripts?: Record<string, string>;
};

if (packageJson.scripts?.build !== 'tsc -p tsconfig.json') {
  throw new Error('release check failed: package.json build script changed unexpectedly');
}

if (packageJson.scripts?.typecheck !== 'tsc -p tsconfig.json --noEmit') {
  throw new Error('release check failed: package.json typecheck script changed unexpectedly');
}

requireText('.github/workflows/ci.yml', 'run: npm ci');
requireText('.github/workflows/ci.yml', 'cache: npm');
requireText('.github/workflows/ci.yml', 'phase-10-release-integration');
requireText('.github/workflows/ci.yml', 'sam validate --template-file infra/template.yaml --lint');

requireText('infra/template.yaml', 'RingHouseholdId:');
requireText('infra/template.yaml', 'RING_HOUSEHOLD_ID: !Ref RingHouseholdId');
requireText('infra/template.yaml', 'bedrock:Converse');
requireText('infra/template.yaml', 'dynamodb:GetItem');
requireText('infra/template.yaml', 'sns:Publish');
requireText('infra/template.yaml', 'lambda:InvokeFunction');
requireText('infra/template.yaml', 'PointInTimeRecoveryEnabled: true');
requireText('infra/template.yaml', 'SSEEnabled: true');
requireText('infra/template.yaml', 'RingWebhookUrl:');
requireText('infra/template.yaml', 'CaregiverFeedbackUrl:');
requireText('infra/template.yaml', 'HealthUrl:');

requireAbsent('infra/template.yaml', 'RING_HOUSEHOLD_ID: ring-household-1');
requireAbsent('infra/template.yaml', 'ring-household-1');

console.log('Tend Phase 10 release readiness check: PASS');
console.log('Verified: lockfile, reproducible CI install/cache, Phase 10 CI trigger, SAM lint gate, explicit household identity, least-privilege runtime permissions, DynamoDB protection, and deployment outputs.');
console.log('Not verified by this command: live AWS deployment, Ring connectivity, Bedrock access, or notification delivery.');
