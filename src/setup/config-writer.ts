import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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

// ── In-session config patching (for /login and /logout) ──

/**
 * Append a `[providers.<id>]` section to the existing config.toml.
 * Does NOT clobber the file — only adds the section if it doesn't exist.
 * If no config file exists, creates one via writeProviderConfig.
 */
export function appendProviderSection(
  customProvider: CustomProviderConfig,
): WriteConfigResult {
  const configPath = getSetupConfigPath();
  if (!existsSync(configPath)) {
    return writeProviderConfig(customProvider.id, {
      force: true,
      customProvider,
    });
  }

  const existing = readFileSync(configPath, "utf-8");
  const sectionHeader = `[providers.${customProvider.id}]`;

  if (existing.includes(sectionHeader)) {
    return {
      written: false,
      path: configPath,
      message: `Provider section [providers.${customProvider.id}] already exists in ${configPath}`,
    };
  }

  let section = `\n${sectionHeader}\n`;
  section += `api = "${escapeTomlString(customProvider.api)}"\n`;
  section += `base_url = "${escapeTomlString(customProvider.baseUrl)}"\n`;
  if (customProvider.envKey) {
    section += `env_key = "${escapeTomlString(customProvider.envKey)}"\n`;
  }

  const newContent = existing.endsWith("\n")
    ? existing + section
    : existing + "\n" + section;

  try {
    writeFileSync(configPath, newContent, "utf-8");
    return {
      written: true,
      path: configPath,
      message: `Added [providers.${customProvider.id}] section to ${configPath}`,
    };
  } catch (err) {
    return {
      written: false,
      path: configPath,
      message: `Failed to write config: ${(err as Error).message}`,
    };
  }
}

/**
 * Remove a `[providers.<id>]` section from config.toml.
 * Uses a line-based parser: finds the section header, removes all lines
 * until the next `[` section start or EOF. Preserves all other content.
 */
export function removeProviderSection(providerId: string): WriteConfigResult {
  const configPath = getSetupConfigPath();
  if (!existsSync(configPath)) {
    return {
      written: false,
      path: configPath,
      message: `No config file at ${configPath}`,
    };
  }

  const existing = readFileSync(configPath, "utf-8");
  const lines = existing.split("\n");

  const sectionHeader = `[providers.${providerId}]`;
  const startIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  if (startIndex === -1) {
    return {
      written: false,
      path: configPath,
      message: `Section [providers.${providerId}] not found in ${configPath}`,
    };
  }

  // Find section end: next line starting with '[' (a new TOML table)
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (/^\[[^\[]/.test(trimmed)) {
      endIndex = i;
      break;
    }
  }

  // Remove the section. Also remove a preceding blank line for cleanliness.
  let removeStart = startIndex;
  if (removeStart > 0 && lines[removeStart - 1]!.trim() === "") {
    removeStart--;
  }
  // Remove a trailing blank line if the section had one (avoid double blanks).
  if (endIndex < lines.length && lines[endIndex]!.trim() === "") {
    endIndex++;
  }

  const newLines = [
    ...lines.slice(0, removeStart),
    ...lines.slice(endIndex),
  ];

  try {
    writeFileSync(configPath, newLines.join("\n"), "utf-8");
    return {
      written: true,
      path: configPath,
      message: `Removed [providers.${providerId}] section from ${configPath}`,
    };
  } catch (err) {
    return {
      written: false,
      path: configPath,
      message: `Failed to write config: ${(err as Error).message}`,
    };
  }
}

/**
 * Update the `provider` (and optionally `model`) line in the `[llm]` section
 * of config.toml. Does NOT clobber the file — only patches the named lines.
 * If no config file exists, creates one via writeProviderConfig.
 */
export function updateLlmProvider(
  provider: string,
  model?: string,
): WriteConfigResult {
  const configPath = getSetupConfigPath();
  if (!existsSync(configPath)) {
    return writeProviderConfig(provider, { force: true, model });
  }

  const existing = readFileSync(configPath, "utf-8");
  const lines = existing.split("\n");

  // Find the [llm] section.
  let llmStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "[llm]") {
      llmStart = i;
      break;
    }
  }

  if (llmStart === -1) {
    return writeProviderConfig(provider, { force: true, model });
  }

  // Find the end of the [llm] section (next section header or EOF).
  let llmEnd = lines.length;
  for (let i = llmStart + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i]!.trim())) {
      llmEnd = i;
      break;
    }
  }

  let providerUpdated = false;
  let modelUpdated = false;
  const newLines = [...lines];

  for (let i = llmStart + 1; i < llmEnd; i++) {
    if (/^\s*provider\s*=/.test(newLines[i]!)) {
      newLines[i] = `provider = "${escapeTomlString(provider)}"`;
      providerUpdated = true;
    }
    if (model && /^\s*model\s*=/.test(newLines[i]!)) {
      newLines[i] = `model = "${escapeTomlString(model)}"`;
      modelUpdated = true;
    }
  }

  // Insert lines that weren't found.
  if (!providerUpdated) {
    newLines.splice(llmStart + 1, 0, `provider = "${escapeTomlString(provider)}"`);
    llmEnd++;
  }
  if (model && !modelUpdated) {
    newLines.splice(llmStart + 2, 0, `model = "${escapeTomlString(model)}"`);
  }

  try {
    writeFileSync(configPath, newLines.join("\n"), "utf-8");
    return {
      written: true,
      path: configPath,
      message: `Updated [llm] provider in ${configPath}`,
    };
  } catch (err) {
    return {
      written: false,
      path: configPath,
      message: `Failed to write config: ${(err as Error).message}`,
    };
  }
}
