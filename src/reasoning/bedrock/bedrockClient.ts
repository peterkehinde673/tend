import { BedrockConfig } from './bedrockConfig';
import { BedrockInvocationError, BedrockSdkUnavailableError } from './bedrockTypes';

interface BedrockRuntimeModuleShape {
  BedrockRuntimeClient: new (opts: { region: string }) => { send: (command: unknown) => Promise<unknown> };
  ConverseCommand: new (input: {
    modelId: string;
    system: { text: string }[];
    messages: { role: 'user'; content: { text: string }[] }[];
  }) => unknown;
}

export type BedrockRuntimeModuleLoader = () => Promise<BedrockRuntimeModuleShape>;

async function loadBedrockRuntimeModule(): Promise<BedrockRuntimeModuleShape> {
  try {
    const moduleName = '@aws-sdk/client-bedrock-runtime';
    const mod: unknown = await import(moduleName);
    return mod as BedrockRuntimeModuleShape;
  } catch (err) {
    throw new BedrockSdkUnavailableError(
      `Could not load the "@aws-sdk/client-bedrock-runtime" package: ${(err as Error).message}. ` +
        `This package must be installed (npm install) before any real Bedrock call can be made. ` +
        `In this project's own sandboxed development environment, installation is blocked by the network egress ` +
        `policy — see README "AWS / Amazon Bedrock Integration" for the confirmed, reproducible reason.`,
      err,
    );
  }
}

export class BedrockClient {
  constructor(
    private readonly config: BedrockConfig,
    private readonly moduleLoader: BedrockRuntimeModuleLoader = loadBedrockRuntimeModule,
  ) {}

  async converse(systemPrompt: string, userMessage: string): Promise<string> {
    const sdk = await this.moduleLoader();

    const client = new sdk.BedrockRuntimeClient({ region: this.config.region });
    const command = new sdk.ConverseCommand({
      modelId: this.config.modelId,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userMessage }] }],
    });

    let response: unknown;
    try {
      response = await client.send(command);
    } catch (err) {
      throw new BedrockInvocationError(
        `Bedrock Converse call failed for model "${this.config.modelId}" in region "${this.config.region}": ${(err as Error).message}`,
        err,
      );
    }

    const text = extractConverseText(response);
    if (text === undefined) {
      throw new BedrockInvocationError('Bedrock response did not contain the expected text content shape (output.message.content[0].text).');
    }
    return text;
  }
}

export function extractConverseText(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const output = (response as { output?: unknown }).output;
  if (!output || typeof output !== 'object') return undefined;
  const message = (output as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!first || typeof first !== 'object') return undefined;
  const text = (first as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}
