import { getModels } from "@earendil-works/pi-ai/compat";

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
  const piModels = getModels("amazon-bedrock" as never) ?? [];
  const byId = new Map(
    piModels.map((m) => [m.id, (m as { contextWindow?: number }).contextWindow ?? null]),
  );

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
    out.set(id, null);
  }
  return out;
}

async function withOptionalBearerToken<T>(
  bearerToken: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!bearerToken) return fn();
  const prev = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = bearerToken;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = prev;
  }
}

async function defaultListFoundationModels(opts: {
  region: string;
  bearerToken?: string;
}): Promise<FoundationModelLike[]> {
  const { BedrockClient, ListFoundationModelsCommand } = await import(
    "@aws-sdk/client-bedrock"
  );
  return withOptionalBearerToken(opts.bearerToken, async () => {
    const client = new BedrockClient({ region: opts.region });
    const resp = await client.send(
      new ListFoundationModelsCommand({ byOutputModality: "TEXT" }),
    );
    return (resp.modelSummaries ?? [])
      .filter((m): m is NonNullable<typeof m> & { modelId: string } => !!m.modelId)
      .map((m) => ({
        modelId: m.modelId!,
        inputModalities: m.inputModalities as string[] | undefined,
        outputModalities: m.outputModalities as string[] | undefined,
        responseStreamingSupported: m.responseStreamingSupported,
      }));
  });
}

async function defaultListInferenceProfiles(opts: {
  region: string;
  bearerToken?: string;
}): Promise<InferenceProfileLike[]> {
  const { BedrockClient, ListInferenceProfilesCommand } = await import(
    "@aws-sdk/client-bedrock"
  );
  return withOptionalBearerToken(opts.bearerToken, async () => {
    const client = new BedrockClient({ region: opts.region });
    const out: InferenceProfileLike[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await client.send(
        new ListInferenceProfilesCommand({ nextToken }),
      );
      for (const p of resp.inferenceProfileSummaries ?? []) {
        if (!p.inferenceProfileId) continue;
        out.push({
          inferenceProfileId: p.inferenceProfileId,
          status: p.status,
          type: p.type,
          models: (p.models ?? []).map((m) => ({ modelArn: m.modelArn })),
        });
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    return out;
  });
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
