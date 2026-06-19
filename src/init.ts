import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectProviderFromEnvironment, listAvailableProviders } from "./llm.js";
import { DEFAULT_MODELS } from "./llm.js";
import { getAppLogger } from "./logger.js";

export interface InitOptions {
  force: boolean;
  cwd: string;
}

export interface InitResult {
  success: boolean;
  path: string;
  action: "created" | "overwritten" | "skipped" | "error";
  message: string;
}

/**
 * Generate a config file content based on detected providers.
 */
function generateConfigContent(detected: { provider: string; model: string } | null): string {
  const lines: string[] = [
    "# PRAANA Configuration",
    "# https://github.com/amitkumardubey/praana",
    "",
    "[llm]",
  ];

  if (detected) {
    lines.push(
      `# Auto-detected provider from environment`,
      `provider = "${detected.provider}"`,
      `model = "${detected.model}"`,
    );
  } else {
    lines.push(
      "# Uncomment and set your provider and model",
      "# provider = \"openrouter\"",
      "# model = \"deepseek/deepseek-v4-flash:free\"",
      "",
      "# Supported providers (set the corresponding env var):",
      "#   anthropic    → ANTHROPIC_API_KEY",
      "#   openai       → OPENAI_API_KEY",
      "#   deepseek     → DEEPSEEK_API_KEY",
      "#   groq         → GROQ_API_KEY",
      "#   google       → GOOGLE_GENERATIVE_AI_API_KEY",
      "#   mistral      → MISTRAL_API_KEY",
      "#   xai          → XAI_API_KEY",
      "#   fireworks    → FIREWORKS_API_KEY",
      "#   together     → TOGETHER_API_KEY",
      "#   opencode     → OPENCODE_API_KEY",
      "#   openrouter   → OPENROUTER_API_KEY",
      "#   ollama       → (local, no key needed)",
    );
  }

  lines.push(
    "",
    "# Memory configuration",
    "# [memory]",
    "# enabled = true",
    "# embedder = \"auto\"  # transformers when installed, else keyword-only search",
    "",
    "# Compiler settings",
    "# [compiler]",
    "# token_budget = 100000",
    "# recent_turns = 10",
    "",
    "# UI mode: \"tui\" or \"readline\"",
    "# [ui]",
    "# mode = \"tui\"",
    "",
  );

  return lines.join("\n");
}

/**
 * Handle the `praana init` command.
 * Creates a config file in the current directory.
 */
export function handleInit(opts: InitOptions): InitResult {
  const logger = getAppLogger().child("app");
  const configPath = resolve(opts.cwd, "praana.config.toml");

  // Check if config already exists
  if (existsSync(configPath) && !opts.force) {
    const message = `Config file already exists: ${configPath}\nUse --force to overwrite.`;
    logger.warn(message);
    return {
      success: false,
      path: configPath,
      action: "skipped",
      message,
    };
  }

  // Detect available providers
  const detected = detectProviderFromEnvironment();
  const available = listAvailableProviders();

  // Generate config content
  const content = generateConfigContent(detected);

  try {
    writeFileSync(configPath, content, "utf-8");

    let message: string;
    if (detected) {
      message = `Created config with detected provider "${detected.provider}" at ${configPath}`;
    } else if (available.length > 0) {
      message = `Created config template at ${configPath}\nAvailable providers in environment: ${available.join(", ")}\nEdit the config to uncomment your provider.`;
    } else {
      message = `Created config template at ${configPath}\nNo provider API keys detected. Set a key (e.g., export OPENROUTER_API_KEY=sk-or-...) and edit the config.`;
    }

    logger.info(message, { details: { path: configPath } });
    return {
      success: true,
      path: configPath,
      action: existsSync(configPath) && !opts.force ? "created" : "overwritten",
      message,
    };
  } catch (err) {
    const message = `Failed to create config file: ${(err as Error).message}`;
    logger.error(message, { cause: err as Error });
    return {
      success: false,
      path: configPath,
      action: "error",
      message,
    };
  }
}
