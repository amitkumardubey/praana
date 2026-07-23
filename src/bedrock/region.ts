/**
 * Resolve the AWS region used for Bedrock catalog listing and invoke.
 * Precedence: config.region → AWS_REGION → AWS_DEFAULT_REGION → us-east-1.
 */
export function resolveBedrockRegion(config?: { region?: string }): string {
  const fromConfig = config?.region?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv =
    process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
  if (fromEnv) return fromEnv;
  return "us-east-1";
}
