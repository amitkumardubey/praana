import { getModel, getProviders } from "@earendil-works/pi-ai";
import {
  findOpenRouterCatalogModelId,
  isInPiAiCatalog,
} from "./model-context.js";
import { isProviderAvailable, getMissingKeyMessage, listKnownProviders } from "./llm.js";

export type ResolveSource =
  | "native-catalog"
  | "openrouter-catalog"
  | "model-only"
  | "openrouter-fallback";

export interface ResolvedModelSpecifier {
  provider: string;
  modelId: string;
  switchedProvider: boolean;
  source: ResolveSource;
  /** True when the model id exists in pi-ai or the live OpenRouter catalog. */
  known: boolean;
}

function isPiAiProviderName(name: string): boolean {
  return (getProviders() as string[]).includes(name);
}

/** PRAANA-only providers (e.g. ollama) not in pi-ai but valid for native switch. */
function isPraanaOnlyProvider(name: string): boolean {
  return listKnownProviders().includes(name) && !isPiAiProviderName(name);
}

function stripOpenRouterProviderPrefix(modelId: string): string {
  return modelId.startsWith("openrouter/") ? modelId.slice("openrouter/".length) : modelId;
}

function resolveNativeCatalog(
  prefix: string,
  suffix: string,
  currentProvider: string,
): ResolvedModelSpecifier | null {
  if (!isPiAiProviderName(prefix) && !isPraanaOnlyProvider(prefix)) {
    return null;
  }
  if (isPraanaOnlyProvider(prefix)) {
    return {
      provider: prefix,
      modelId: suffix,
      switchedProvider: prefix !== currentProvider,
      source: "native-catalog",
      known: true,
    };
  }
  if (!isInPiAiCatalog(prefix, suffix)) {
    return null;
  }
  return {
    provider: prefix,
    modelId: suffix,
    switchedProvider: prefix !== currentProvider,
    source: "native-catalog",
    known: true,
  };
}

function resolveOpenRouter(
  fullSpec: string,
  currentProvider: string,
  source: "openrouter-catalog" | "openrouter-fallback",
): ResolvedModelSpecifier {
  const modelId = stripOpenRouterProviderPrefix(fullSpec);
  return {
    provider: "openrouter",
    modelId,
    switchedProvider: currentProvider !== "openrouter",
    source,
    known: source === "openrouter-catalog",
  };
}

export function resolveModelSpecifierSync(
  spec: string,
  currentProvider: string,
): ResolvedModelSpecifier {
  const trimmed = spec.trim();
  if (!trimmed) {
    return {
      provider: currentProvider,
      modelId: trimmed,
      switchedProvider: false,
      source: "model-only",
      known: false,
    };
  }

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0) {
    const prefix = trimmed.slice(0, slashIdx);
    const suffix = trimmed.slice(slashIdx + 1);

    // Explicit OpenRouter escape hatch: /model openrouter/vendor/model
    if (prefix === "openrouter" && suffix) {
      if (isInPiAiCatalog("openrouter", suffix)) {
        return {
          provider: "openrouter",
          modelId: suffix,
          switchedProvider: currentProvider !== "openrouter",
          source: "native-catalog",
          known: true,
        };
      }
      return resolveOpenRouter(suffix, currentProvider, "openrouter-fallback");
    }

    const native = resolveNativeCatalog(prefix, suffix, currentProvider);
    if (native) return native;

    if (isInPiAiCatalog("openrouter", trimmed)) {
      return resolveOpenRouter(trimmed, currentProvider, "openrouter-catalog");
    }

    return resolveOpenRouter(trimmed, currentProvider, "openrouter-fallback");
  }

  return {
    provider: currentProvider,
    modelId: trimmed,
    switchedProvider: false,
    source: "model-only",
    known: knownModelOnly(currentProvider, trimmed),
  };
}

function knownModelOnly(provider: string, modelId: string): boolean {
  if (isPraanaOnlyProvider(provider)) return true;
  return isInPiAiCatalog(provider, modelId);
}

export async function resolveModelSpecifier(
  spec: string,
  currentProvider: string,
): Promise<ResolvedModelSpecifier> {
  const sync = resolveModelSpecifierSync(spec, currentProvider);
  if (sync.known) return sync;

  const canonical = await findOpenRouterCatalogModelId(sync.modelId);
  if (canonical) {
    return {
      provider: "openrouter",
      modelId: canonical,
      switchedProvider: sync.provider !== "openrouter" || sync.switchedProvider,
      source: "openrouter-catalog",
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
