// ============================================================
// PRAANA — Vertex AI endpoint, location and project resolution
// ============================================================

/**
 * A Vertex AI request cannot be built from the configuration: the location,
 * project or model is missing or malformed. Not an authentication failure, so
 * drivers report it without an HTTP status.
 */
export class VertexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VertexConfigError";
  }
}

/** Location used when neither `VERTEX_REGION` nor `GOOGLE_CLOUD_LOCATION` is set. */
export const DEFAULT_VERTEX_LOCATION = "us-central1";

export const VERTEX_PROJECT_MISSING_MESSAGE =
  "Vertex AI project is not set: set VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT";

const LOCATION_PATTERN = /^[a-z0-9-]+$/;
// Domain-scoped project ids (`example.com:my-project`) contain `.` and `:`.
const PROJECT_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MODEL_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Env vars read for the location, in precedence order. */
const LOCATION_ENV_KEYS = ["VERTEX_REGION", "GOOGLE_CLOUD_LOCATION"] as const;
/** Env vars read for the project, in precedence order. */
const PROJECT_ENV_KEYS = ["VERTEX_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT"] as const;

function firstEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return undefined;
}

/**
 * Location for Vertex requests: `VERTEX_REGION`, then `GOOGLE_CLOUD_LOCATION`,
 * then {@link DEFAULT_VERTEX_LOCATION}. Throws {@link VertexConfigError} for a
 * value that is not a plain location id.
 */
export function resolveVertexLocation(env: NodeJS.ProcessEnv = process.env): string {
  const found = firstEnv(env, LOCATION_ENV_KEYS);
  if (!found) return DEFAULT_VERTEX_LOCATION;
  if (!LOCATION_PATTERN.test(found.value)) {
    throw new VertexConfigError(
      `${found.key} is not a valid Vertex AI location: use lowercase letters, digits and dashes (for example global or us-central1)`,
    );
  }
  return found.value;
}

/**
 * Project from the environment: `VERTEX_PROJECT_ID`, then
 * `GOOGLE_CLOUD_PROJECT`, then `GCP_PROJECT`. Undefined when none is set;
 * credential files may still supply one.
 */
export function resolveVertexProjectFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return firstEnv(env, PROJECT_ENV_KEYS)?.value;
}

/** `aiplatform.googleapis.com` serves `global`; other locations have a regional host. */
function vertexHost(location: string): string {
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}

export interface VertexEndpointParts {
  location: string;
  project: string;
  model: string;
}

function isDotSegment(value: string): boolean {
  return value === "." || value === "..";
}

/**
 * Streaming URL for a Google-published model on Vertex AI.
 *
 * Segments are validated and interpolated as they are: percent-encoding would
 * turn the `:` of a domain-scoped project into `%3A`, and `new URL` decodes
 * `%2e%2e` into a path-traversing segment, so anything outside the allowed
 * character sets is refused instead of escaped. Values are not echoed in the
 * error text.
 */
export function vertexEndpoint(parts: VertexEndpointParts): string {
  const { location, project, model } = parts;
  if (!LOCATION_PATTERN.test(location)) {
    throw new VertexConfigError(
      "Invalid Vertex AI location: use lowercase letters, digits and dashes (for example global or us-central1)",
    );
  }
  if (!PROJECT_PATTERN.test(project) || isDotSegment(project)) {
    throw new VertexConfigError(
      "Invalid Vertex AI project id: use letters, digits, dots, colons, dashes and underscores",
    );
  }
  if (!MODEL_PATTERN.test(model) || isDotSegment(model) || /^\d+$/.test(model)) {
    throw new VertexConfigError(
      "Invalid Vertex AI model id: use letters, digits, dots, dashes and underscores",
    );
  }
  return `https://${vertexHost(location)}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
}
