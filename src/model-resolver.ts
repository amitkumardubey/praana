import { getProviders } from "@earendil-works/pi-ai";
import {
  findProviderCatalogModelId,
  isInProviderCatalog,
  providerSupportsLiveCatalog,
  stripProviderRoutingPrefix,
} from "./provider-catalog.js";
import { isInPiAiCatalog } from "./model-context.js";
import { isProviderAvailable, getMissingKeyMessage, listKnownProviders } from "./llm.js";

export type ResolveSource =
  | "native-catalog"
  | "provider-catalog"
  | "model-only"
  | "provider-fallback";



export interface ResolvedModelSpecifier {
  provider: string;
  modelId: string;
  switchedProvider: boolean;
  source: ResolveSource;
  /** True when the model id exists in pi-ai or the provider's live catalog. */
  known: boolean;
}

export type ParsedModelCommand =
  | { kind: "help" }
  | { kind: "resolve"; explicitProvider: string | null; modelSpec: string; userInput: string };

/**
 * Format a provider + model id pair into the active model label string.
 *
 * Convention: `provider/model` or `provider/vendor/model` for routed models.
 * - `formatActiveModelLabel("openai", "gpt-4o")` → `"openai/gpt-4o"`
 * - `formatActiveModelLabel("openrouter", "moonshotai/kimi-k2.7-code")` → `"openrouter/moonshotai/kimi-k2.7-code"`
 *
 * The three-segment form `provider/vendor/model` means "provider routing to vendor's model".
 */
export function formatActiveModelLabel(provider: string, modelId: string): string {
  const routingPrefix = `${provider}/`;
  if (modelId.startsWith(routingPrefix)) return modelId;
  return `${routingPrefix}${modelId}`;
}

export function resolvedTargetLabel(
  resolved: ResolvedModelSpecifier,
  currentProvider: string,
): string {
  const provider = resolved.switchedProvider ? resolved.provider : currentProvider;
  return formatActiveModelLabel(provider, resolved.modelId);
}

function isPiAiProviderName(name: string): boolean {
  return (getProviders() as string[]).includes(name);
}

/** PRAANA-only providers (e.g. ollama) not in pi-ai but valid for native switch. */
function isPraanaOnlyProvider(name: string): boolean {
  return listKnownProviders().includes(name) && !isPiAiProviderName(name);
}

export function isKnownProviderName(name: string): boolean {
  return isPiAiProviderName(name) || isPraanaOnlyProvider(name);
}

/**
 * Parse `/model [provider] <model-id>` (space-separated provider only).
 * Without a provider, the full model id applies to the current provider (may contain `/`).
 */
export function parseModelCommandArgs(commandParts: string[]): ParsedModelCommand {
  const args = commandParts.slice(1);
  if (args.length === 0 || !args[0]?.trim()) {
    return { kind: "help" };
  }

  const userInput = args.join(" ");

  if (args.length >= 2 && isKnownProviderName(args[0]!.trim())) {
    return {
      kind: "resolve",
      explicitProvider: args[0]!.trim(),
      modelSpec: args.slice(1).join(" ").trim(),
      userInput,
    };
  }

  return {
    kind: "resolve",
    explicitProvider: null,
    modelSpec: userInput.trim(),
    userInput,
  };
}

function resolveCatalogHit(
  provider: string,
  modelId: string,
  switchedProvider: boolean,
): ResolvedModelSpecifier {
  return {
    provider,
    modelId,
    switchedProvider,
    source: "native-catalog",
    known: true,
  };
}

function resolvePendingCatalogLookup(
  provider: string,
  modelId: string,
  switchedProvider: boolean,
): ResolvedModelSpecifier {
  return {
    provider,
    modelId,
    switchedProvider,
    source: providerSupportsLiveCatalog(provider) ? "provider-fallback" : "model-only",
    known: false,
  };
}

function resolveWithExplicitProvider(
  provider: string,
  modelSpec: string,
  currentProvider: string,
): ResolvedModelSpecifier {
  const modelId = stripProviderRoutingPrefix(provider, modelSpec.trim());
  const switchedProvider = provider !== currentProvider;

  if (isPraanaOnlyProvider(provider)) {
    return resolveCatalogHit(provider, modelId, switchedProvider);
  }

  if (isInPiAiCatalog(provider, modelId)) {
    return resolveCatalogHit(provider, modelId, switchedProvider);
  }

  return resolvePendingCatalogLookup(provider, modelId, switchedProvider);
}

export function resolveModelSpecifierSync(
  modelSpec: string,
  currentProvider: string,
  explicitProvider: string | null = null,
): ResolvedModelSpecifier {
  const trimmed = modelSpec.trim();
  if (!trimmed) {
    return {
      provider: currentProvider,
      modelId: trimmed,
      switchedProvider: false,
      source: "model-only",
      known: false,
    };
  }

  if (explicitProvider) {
    return resolveWithExplicitProvider(explicitProvider, trimmed, currentProvider);
  }

  const modelId = stripProviderRoutingPrefix(currentProvider, trimmed);

  return {
    provider: currentProvider,
    modelId,
    switchedProvider: false,
    source: "model-only",
    known: knownModelOnly(currentProvider, modelId),
  };
}

function knownModelOnly(provider: string, modelId: string): boolean {
  if (isPraanaOnlyProvider(provider)) return true;
  return isInPiAiCatalog(provider, modelId);
}

export async function resolveModelSpecifier(
  modelSpec: string,
  currentProvider: string,
  explicitProvider: string | null = null,
): Promise<ResolvedModelSpecifier> {
  const sync = resolveModelSpecifierSync(modelSpec, currentProvider, explicitProvider);
  if (sync.known) return sync;

  if (!providerSupportsLiveCatalog(sync.provider)) {
    return { ...sync, known: false };
  }

  const canonical = await findProviderCatalogModelId(sync.provider, sync.modelId);
  if (canonical) {
    return {
      ...sync,
      modelId: canonical,
      source: "provider-catalog",
      known: true,
    };
  }

  return { ...sync, known: false };
}

export function isProviderConfigured(provider: string): boolean {
  return isProviderAvailable(provider);
}

export function getProviderConfigurationError(provider: string): string | null {
  return getMissingKeyMessage(provider);
}

/** @internal test helper — direct pi-ai catalog probe */
export function catalogHasModel(provider: string, modelId: string): boolean {
  return isInPiAiCatalog(provider, modelId);
}

/** @internal test helper — live provider catalog probe */
export async function liveCatalogHasModel(
  provider: string,
  modelId: string,
): Promise<boolean> {
  return isInProviderCatalog(provider, modelId);
}
