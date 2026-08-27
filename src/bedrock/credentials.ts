import { getApiKey, hasApiKey } from "../credentials.js";

const AMBIENT_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

/** True when any common AWS ambient credential env var is set. */
export function hasAmbientAwsCredentials(): boolean {
  return AMBIENT_KEYS.some((k) => !!process.env[k]?.trim());
}

/** Credential-store Bedrock API key wins over AWS_BEARER_TOKEN_BEDROCK. */
export function resolveBedrockBearerToken(): string | undefined {
  const stored = getApiKey("amazon-bedrock")?.trim();
  if (stored) return stored;
  const env = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  return env || undefined;
}

export function isBedrockAvailable(): boolean {
  return hasApiKey("amazon-bedrock") || hasAmbientAwsCredentials();
}

export function getBedrockMissingCredentialsMessage(): string {
  return (
    "Amazon Bedrock is not configured. Set AWS credentials (AWS_ACCESS_KEY_ID / " +
    "AWS_PROFILE / web identity / container role) or AWS_BEARER_TOKEN_BEDROCK, " +
    "or paste a Bedrock API key via /login."
  );
}
