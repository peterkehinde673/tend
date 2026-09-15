import { ReasoningInput, ReasoningOutput, ReasoningService } from './contract';

/**
 * Wraps a primary ReasoningService (e.g. real Bedrock) with a fallback
 * (e.g. TemplateReasoningService). If the primary throws for ANY reason —
 * missing AWS SDK, network failure, invalid model access, malformed model
 * output that fails safety-contract validation — this falls back rather
 * than propagating the failure, so the rest of the application (dashboard,
 * CLI, tests) never breaks just because AWS/Bedrock isn't configured or
 * isn't reachable.
 *
 * This class is entirely provider-independent: it has no knowledge of
 * Bedrock, AWS, or any other specific reasoning provider — it only knows
 * about the existing `ReasoningService` interface.
 */
export class FallbackReasoningService implements ReasoningService {
  constructor(
    private readonly primary: ReasoningService,
    private readonly fallback: ReasoningService,
    /** Called with a safe (non-sensitive) reason string whenever the fallback is used. Never receives the input/output payloads themselves. */
    private readonly onFallback?: (reason: string) => void,
  ) {}

  async explain(input: ReasoningInput): Promise<ReasoningOutput> {
    try {
      return await this.primary.explain(input);
    } catch (err) {
      this.onFallback?.((err as Error).message);
      return this.fallback.explain(input);
    }
  }
}
