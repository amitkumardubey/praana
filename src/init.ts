import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { detectProviderFromEnvironment, listAvailableProviders } from "./llm.js";
import { DEFAULT_MODELS } from "./llm.js";
import { formatProviderListForDisplay } from "./provider-registry.js";
import { getAppLogger } from "./logger.js";
import { APP_HOME_DIR, appHomePath } from "./app-identity.js";
import { askQuestion, isInteractiveTerminal } from "./terminal.js";

export interface InitOptions {
  force: boolean;
  homeDir?: string;
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
    );
    for (const { name, envKey } of formatProviderListForDisplay()) {
      lines.push(`#   ${name.padEnd(20)} → ${envKey ?? "(local)"}`);
    }
  }

  lines.push(
    "",
    "# Memory configuration",
    "# [memory]",
    "# enabled = true",
    "# embedder = \"auto\"  # transformers (default; model downloads on first run)",
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
 * Creates the global config file at ~/.praana/config.toml.
 */
export async function handleInit(opts: InitOptions): Promise<InitResult> {
  const logger = getAppLogger().child("app");
  const appHomeDir = opts.homeDir ? join(opts.homeDir, APP_HOME_DIR) : appHomePath();
  const configPath = join(appHomeDir, "config.toml");

  // Detect available providers before generating content
  const detected = detectProviderFromEnvironment();
  const available = listAvailableProviders();
  const content = generateConfigContent(detected);

  // Check if config already exists
  if (existsSync(configPath)) {
    if (!opts.force) {
      const message = `Config file already exists: ${configPath}\nUse --force to overwrite.`;
      logger.info(message);
      return {
        success: false,
        path: configPath,
        action: "skipped",
        message,
      };
    }

    // Show a preview of the first few changed lines in interactive mode
    if (isInteractiveTerminal()) {
      const existing = readFileSync(configPath, "utf-8");
      const existingLines = existing.split("\n");
      const newLines = content.split("\n");
      const changed: string[] = [];
      for (let i = 0; i < Math.max(existingLines.length, newLines.length); i++) {
        if (existingLines[i] !== newLines[i]) {
          if (existingLines[i] !== undefined) changed.push(`- ${existingLines[i]}`);
          if (newLines[i] !== undefined) changed.push(`+ ${newLines[i]}`);
          if (changed.length >= 10) break;
        }
      }
      if (changed.length > 0) {
        console.error("");
        console.error("Config changes preview:");
        for (const line of changed.slice(0, 10)) console.error(`  ${line}`);
        console.error("");
      }
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await askQuestion(rl, "Overwrite? (y/n): ");
        if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
          return {
            success: true,
            path: configPath,
            action: "skipped",
            message: `Config left unchanged at ${configPath}.`,
          };
        }
      } finally {
        rl.close();
      }
    }
  }

  try {
    mkdirSync(appHomeDir, { recursive: true });
    const existed = existsSync(configPath);
    writeFileSync(configPath, content, "utf-8");

    // Create a global AGENTS.md template if none exists
    const agentsPath = join(appHomeDir, "AGENTS.md");
    let agentsCreated = false;
    if (!existsSync(agentsPath)) {
      const agentsTemplate = `# Personal Instructions\n\n# Add your global preferences, coding style, or context here.\n# This file is loaded into every PRAANA session.\n`;
      writeFileSync(agentsPath, agentsTemplate, "utf-8");
      agentsCreated = true;
    }

    let message: string;
    if (detected) {
      message = `Created config with detected provider "${detected.provider}" at ${configPath}`;
    } else if (available.length > 0) {
      message = `Created config template at ${configPath}\nAvailable providers in environment: ${available.join(", ")}\nEdit the config to uncomment your provider.`;
    } else {
      message = `Created config template at ${configPath}\nNo provider API keys detected. Set a key (e.g., export OPENROUTER_API_KEY=sk-or-...) and edit the config.`;
    }
    if (agentsCreated) {
      message += `\nAlso created ${agentsPath} for global personal instructions.`;
    }
    logger.info(message, { details: { path: configPath } });
    return {
      success: true,
      path: configPath,
      action: existed ? "overwritten" : "created",
      message,
    };
  } catch (err) {
    const message = `Failed to create config file: ${(err as Error).message}`;
    logger.info(message, { details: { cause: (err as Error).message } });
    return {
      success: false,
      path: configPath,
      action: "error",
      message,
    };
  }
}
