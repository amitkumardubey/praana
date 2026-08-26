import { getCuratedModels } from "../llm/catalog.js";
import { resolveContextWindowSync } from "../llm/context-window.js";
import { signAwsRequest } from "../llm/aws-sigv4.js";

export interface FoundationModelLike {
  modelId: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
}

export interface InferenceProfileLike {
  inferenceProfileId: string;
  status?: string;
  type?: string;
  models?: Array<{ modelArn?: string }>;
}

/** Extract foundation model id from a Bedrock model ARN, or null. */
export function foundationModelIdFromArn(arn: string): string | null {
  const marker = "foundation-model/";
  const idx = arn.indexOf(marker);
  if (idx < 0) return null;
  const id = arn.slice(idx + marker.length).trim();
  return id || null;
}

/**
 * Chat-capable TEXT models only.
 * Hard-excludes when responseStreamingSupported === false; keeps when absent.
 */
export function isChatCapableFoundationModel(m: FoundationModelLike): boolean {
  const inputs = m.inputModalities ?? [];
  const outputs = m.outputModalities ?? [];
  if (!inputs.includes("TEXT") || !outputs.includes("TEXT")) return false;
  if (m.responseStreamingSupported === false) return false;
  return true;
}

/**
 * Prefer inference profiles for chat-capable foundation models; keep base IDs
 * only when no qualifying profile covers them.
 */
export function buildBedrockCatalogIds(input: {
  foundationModels: FoundationModelLike[];
  profiles: InferenceProfileLike[];
}): string[] {
  const chatCapable = new Set(
    input.foundationModels
      .filter(isChatCapableFoundationModel)
      .map((m) => m.modelId),
  );

  const covered = new Set<string>();
  const profileIds: string[] = [];

  for (const profile of input.profiles) {
    if (profile.status && profile.status !== "ACTIVE") continue;
    const linked = (profile.models ?? [])
      .map((m) => (m.modelArn ? foundationModelIdFromArn(m.modelArn) : null))
      .filter((id): id is string => !!id);
    const qualifies = linked.some((id) => chatCapable.has(id));
    if (!qualifies) continue;
    profileIds.push(profile.inferenceProfileId);
    for (const id of linked) {
      if (chatCapable.has(id)) covered.add(id);
    }
  }

  const baseIds = [...chatCapable].filter((id) => !covered.has(id));
  return [...new Set([...profileIds, ...baseIds])].sort((a, b) =>
    a.localeCompare(b),
  );
}

const GEO_PREFIX = /^(us|eu|apac|global)\./i;

function stripGeoPrefix(id: string): string {
  return id.replace(GEO_PREFIX, "");
}

function resolveContextWindows(ids: string[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const curated = getCuratedModels("amazon-bedrock");
  const byId = new Map(curated.map((m) => [m.id, m.contextWindow]));

  for (const id of ids) {
    const direct = byId.get(id);
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 1000) {
      out.set(id, direct);
      continue;
    }
    const stripped = stripGeoPrefix(id);
    const viaBase = byId.get(stripped);
    if (typeof viaBase === "number" && Number.isFinite(viaBase) && viaBase >= 1000) {
      out.set(id, viaBase);
      continue;
    }
    out.set(id, resolveContextWindowSync(id, "amazon-bedrock"));
  }
  return out;
}

async function defaultListFoundationModels(opts: {
  region: string;
  bearerToken?: string;
}): Promise<FoundationModelLike[]> {
  const endpoint = `https://bedrock.${opts.region}.amazonaws.com/foundation-models?byOutputModality=TEXT`;
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  if (opts.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK) {
    headers.Authorization = `Bearer ${opts.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK}`;
  } else {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    if (accessKeyId && secretAccessKey) {
      headers = signAwsRequest({
        method: "GET",
        url: endpoint,
        headers,
        body: "",
        credentials: {
          accessKeyId,
          secretAccessKey,
          sessionToken,
          region: opts.region,
          service: "bedrock",
        },
      });
    }
  }

  try {
    const res = await fetch(endpoint, { method: "GET", headers });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.modelSummaries ?? [])
      .filter((m: any) => !!m.modelId)
      .map((m: any) => ({
        modelId: m.modelId,
        inputModalities: m.inputModalities,
        outputModalities: m.outputModalities,
        responseStreamingSupported: m.responseStreamingSupported,
      }));
  } catch {
    return [];
  }
}

async function defaultListInferenceProfiles(opts: {
  region: string;
  bearerToken?: string;
}): Promise<InferenceProfileLike[]> {
  const endpoint = `https://bedrock.${opts.region}.amazonaws.com/inference-profiles`;
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  if (opts.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK) {
    headers.Authorization = `Bearer ${opts.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK}`;
  } else {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    if (accessKeyId && secretAccessKey) {
      headers = signAwsRequest({
        method: "GET",
        url: endpoint,
        headers,
        body: "",
        credentials: {
          accessKeyId,
          secretAccessKey,
          sessionToken,
          region: opts.region,
          service: "bedrock",
        },
      });
    }
  }

  try {
    const res = await fetch(endpoint, { method: "GET", headers });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.inferenceProfileSummaries ?? [])
      .filter((p: any) => !!p.inferenceProfileId)
      .map((p: any) => ({
        inferenceProfileId: p.inferenceProfileId,
        status: p.status,
        type: p.type,
        models: (p.models ?? []).map((m: any) => ({ modelArn: m.modelArn })),
      }));
  } catch {
    return [];
  }
}

/**
 * Fetch chat-capable Bedrock model ids for a region.
 * Inject list functions in tests to avoid live AWS calls.
 */
export async function fetchBedrockLiveCatalog(opts: {
  region: string;
  bearerToken?: string;
  listFoundationModels?: () => Promise<FoundationModelLike[]>;
  listInferenceProfiles?: () => Promise<InferenceProfileLike[]>;
}): Promise<Record<string, number | null>> {
  const foundationModels =
    (await opts.listFoundationModels?.()) ??
    (await defaultListFoundationModels(opts));
  const profiles =
    (await opts.listInferenceProfiles?.()) ??
    (await defaultListInferenceProfiles(opts));

  const ids = buildBedrockCatalogIds({ foundationModels, profiles });
  const windows = resolveContextWindows(ids);
  const out: Record<string, number | null> = {};
  for (const id of ids) out[id] = windows.get(id) ?? null;
  return out;
}
