/**
 * Resolve the AWS region used for Bedrock catalog listing and invoke.
 * Precedence: explicit config.region → module config region (from loadConfig) →
 * AWS_REGION → AWS_DEFAULT_REGION → us-east-1.
 */

/** Region from last loaded `llm.region` (so catalog fetches see config without opts). */
let _configRegion: string | undefined;

/** Called from loadConfig when llm.region is validated. */
export function setBedrockConfigRegion(region: string | undefined): void {
  _configRegion = region?.trim() || undefined;
}

/** Test helper — clear module region override. */
export function resetBedrockConfigRegionForTests(): void {
  _configRegion = undefined;
}

export function resolveBedrockRegion(config?: { region?: string }): string {
  const fromConfig = config?.region?.trim() || _configRegion;
  if (fromConfig) return fromConfig;
  const fromEnv =
    process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
  if (fromEnv) return fromEnv;
  return "us-east-1";
}
