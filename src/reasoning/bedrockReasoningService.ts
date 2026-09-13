import { ReasoningInput, ReasoningOutput, ReasoningService, validateReasoningOutput } from './contract';

/**
 * Minimal seam around whatever Bedrock client actually performs the model
 * invocation. Real AWS wiring (the @aws-sdk/client-bedrock-runtime call) is
 * intentionally NOT implemented in this phase — per the Phase 1A
 * instructions, production AWS infrastructure is a later phase, and this
 * sandboxed environment has no network access to install the AWS SDK
 * package regardless. Injecting this interface is what lets
 * BedrockReasoningService be fully unit-tested now, with a real
 * implementation dropped in later without touching this class.
 */
export interface ModelInvoker {
  /** Returns the raw text response from the model for a given prompt. */
  invoke(systemPrompt: string, userPayload: ReasoningInput): Promise<string>;
}

/**
 * Builds the system prompt that encodes every hard constraint from the
 * Bedrock safety contract. This is deliberately explicit and repetitive —
 * safety-relevant prompts should not rely on the model inferring intent.
 */
export function buildSystemPrompt(): string {
  return [
    'You are Tend\'s reasoning layer. You translate structured, pre-computed evidence about a household routine deviation into a short, calm, plain-language explanation for a caregiver.',
    '',
    'You MUST:',
    '- Use only the evidence provided in the input JSON. Never invent an event, a time, a number, or a device that is not present in the evidence.',
    '- Return valid JSON matching exactly this shape: { "severityLabel": string, "explanation": string, "evidenceReferences": string[], "recommendedWording": string, "confidence": number, "notifyRecommended": boolean }.',
    '- Set severityLabel to exactly the severity given in the input — you do not decide severity.',
    '- Set recommendedWording to exactly one of: "Consider checking in." | "Worth a quick look." | "No action needed." — never any other wording.',
    '- Reference only evidence "signal" values that exist in the input in evidenceReferences.',
    '',
    'You MUST NOT:',
    '- Diagnose illness or injury, or use medical/diagnostic language.',
    '- Claim or imply an emergency, or suggest contacting emergency services.',
    '- Identify, name, or describe any specific person.',
    '- Perform or reference facial recognition or biometric identification.',
    '- Invent sensor readings, events, or times not present in the evidence.',
  ].join('\n');
}

export class BedrockReasoningService implements ReasoningService {
  constructor(private readonly invoker: ModelInvoker) {}

  async explain(input: ReasoningInput): Promise<ReasoningOutput> {
    const systemPrompt = buildSystemPrompt();
    const rawText = await this.invoker.invoke(systemPrompt, input);

    let parsed: ReasoningOutput;
    try {
      parsed = JSON.parse(rawText) as ReasoningOutput;
    } catch (err) {
      throw new Error(`Reasoning layer returned non-JSON output: ${(err as Error).message}`);
    }

    const problems = validateReasoningOutput(parsed, input);
    if (problems.length > 0) {
      throw new Error(`Reasoning output failed safety contract validation:\n- ${problems.join('\n- ')}`);
    }

    return parsed;
  }
}
