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
