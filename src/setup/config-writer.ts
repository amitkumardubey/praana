import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { DEFAULT_MODELS, pickFirstCatalogModel } from "../llm.js";
import { appHomePath } from "../app-identity.js";
import type { WriteConfigResult, CustomProviderConfig } from "./types.js";

export function resolveDefaultModel(provider: string): string {
  return DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
}

/** Escape a value for a double-quoted TOML basic string. */
export function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Generate the config.toml content for a provider.
 *
 * No `# export KEY=...` comment line — keys are saved to the credential
 * store (~/.praana/credentials.json) by the wizard, not env vars.
 */
export function generateSetupConfigContent(
  provider: string,
  model?: string,
  customProvider?: CustomProviderConfig,
): string {
  const resolvedModel = model ?? resolveDefaultModel(provider);
  const modelLine = resolvedModel
    ? `model = "${escapeTomlString(resolvedModel)}"\n`
    : `# model = "<model-id>"  # set this if PRAANA doesn't auto-detect\n`;

  let customSection = "";
  if (customProvider) {
    customSection =
      `\n[providers.${customProvider.id}]\n` +
      `api = "${escapeTomlString(customProvider.api)}"\n` +
      `base_url = "${escapeTomlString(customProvider.baseUrl)}"\n`;
    if (customProvider.envKey) {
      customSection += `env_key = "${escapeTomlString(customProvider.envKey)}"\n`;
    }
  }

  return (
    `# PRAANA Configuration\n` +
    `# https://github.com/amitkumardubey/praana\n\n` +
    `[llm]\n` +
    `provider = "${escapeTomlString(provider)}"\n` +
    `${modelLine}${customSection}`
  );
}

export function getSetupConfigPath(): string {
  return appHomePath("config.toml");
}

export function writeProviderConfig(
  provider: string,
  opts?: {
    force?: boolean;
    model?: string;
    customProvider?: CustomProviderConfig;
  },
): WriteConfigResult {
  const configPath = getSetupConfigPath();
  const existed = existsSync(configPath);

  if (existed && !opts?.force) {
    return {
      written: false,
      path: configPath,
      message: `Config already exists at ${configPath}`,
    };
  }

  const content = generateSetupConfigContent(
    provider,
    opts?.model,
    opts?.customProvider,
  );
  try {
    mkdirSync(appHomePath(), { recursive: true });
    writeFileSync(configPath, content, "utf-8");
    return {
      written: true,
      path: configPath,
      message: existed
        ? `Updated config at ${configPath}`
        : `Created config at ${configPath}`,
    };
  } catch (err) {
    return {
      written: false,
      path: configPath,
      message: `Failed to write config: ${(err as Error).message}`,
    };
  }
}
