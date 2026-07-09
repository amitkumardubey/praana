import { getAppLogger } from "../logger.js";
import { getProviderEnvKey } from "../provider-registry.js";
import { isProviderAvailable } from "../llm.js";
import { writeProviderConfig } from "./config-writer.js";
import type { SetupResult } from "./types.js";

export interface ProviderSetupInfo {
  provider: string;
  envKey: string | null;
  keyDetected: boolean;
  needsExternalConfig: boolean;
}

export function describeProviderSetup(provider: string): ProviderSetupInfo {
  const envKey = getProviderEnvKey(provider);
  return {
    provider,
    envKey,
    keyDetected: isProviderAvailable(provider),
    needsExternalConfig: envKey === null,
  };
}

export function buildProviderInstructions(info: ProviderSetupInfo): string[] {
  const lines: string[] = [];
  if (info.needsExternalConfig) {
    lines.push(`Provider ${info.provider} does not use a single API key.`);
    lines.push("Configure it separately, then restart PRAANA.");
    return lines;
  }

  const envKey = info.envKey!;
  if (info.keyDetected) {
    lines.push(`✓ ${info.provider} API key detected in environment.`);
    lines.push("");
    lines.push("PRAANA will use it on restart.");
  } else {
    lines.push(`Set your API key before starting PRAANA:`);
    lines.push("");
    lines.push(`  export ${envKey}=<your-api-key>`);
  }
  return lines;
}

export function finalizeProviderSetup(
  provider: string,
  configAction: "write" | "skip" | "overwrite",
): SetupResult {
  const info = describeProviderSetup(provider);
  const logger = getAppLogger().child("app");

  if (configAction === "skip") {
    logger.info(`Interactive setup completed for provider: ${provider}`, {
      details: { provider, configWritten: false },
    });
    if (info.needsExternalConfig) {
      return {
        success: true,
        provider,
        message: `Provider ${provider} requires separate configuration.`,
      };
    }
    return {
      success: true,
      provider,
      message: info.keyDetected
        ? `Provider ${provider} is already configured.`
        : `Setup notes recorded for ${provider}. Set your API key and restart.`,
    };
  }

  const writeResult = writeProviderConfig(provider, {
    force: configAction === "overwrite",
  });

  if (!writeResult.written && configAction === "write") {
    return {
      success: true,
      provider,
      message: writeResult.message,
    };
  }

  logger.info(`Interactive setup completed for provider: ${provider}`, {
    details: { provider, configWritten: writeResult.written, path: writeResult.path },
  });

  if (info.needsExternalConfig) {
    return {
      success: true,
      provider,
      message: writeResult.written
        ? `${writeResult.message}. Configure ${provider} credentials, then restart.`
        : writeResult.message,
    };
  }

  const envKey = info.envKey!;
  if (writeResult.written) {
    const nextSteps = info.keyDetected
      ? [`Config saved: ${writeResult.path}`, "Restart PRAANA to begin."]
      : [
          `Config saved: ${writeResult.path}`,
          `Set your key: export ${envKey}=<your-api-key>`,
          "Restart PRAANA.",
        ];
    return {
      success: true,
      provider,
      message: nextSteps.join(" "),
    };
  }

  return {
    success: true,
    provider,
    message: writeResult.message,
  };
}
