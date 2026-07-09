import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { DEFAULT_MODELS, pickFirstCatalogModel } from "../llm.js";
import { getProviderEnvKey } from "../provider-registry.js";
import { appHomePath } from "../app-identity.js";
import type { WriteConfigResult } from "./types.js";

export function resolveDefaultModel(provider: string): string {
  return DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
}

export function generateSetupConfigContent(provider: string, model?: string): string {
  const resolvedModel = model ?? resolveDefaultModel(provider);
  const envKey = getProviderEnvKey(provider);
  const modelLine = resolvedModel
    ? `model = "${resolvedModel}"\n`
    : `# model = "<model-id>"  # set this if PRAANA doesn't auto-detect\n`;
  const keyComment = envKey
    ? `# export ${envKey}=<your-api-key>`
    : "# Set credentials for this provider in your environment";

  return `# PRAANA Configuration
# https://github.com/amitkumardubey/praana

[llm]
provider = "${provider}"
${modelLine}
# Set your API key as an environment variable:
${keyComment}
`;
}

export function getSetupConfigPath(): string {
  return appHomePath("config.toml");
}

export function writeProviderConfig(
  provider: string,
  opts?: { force?: boolean },
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

  const content = generateSetupConfigContent(provider);
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
