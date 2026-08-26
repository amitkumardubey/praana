import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
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
 * Generate a commented config template.
 * Provider choice belongs to guided setup — do not pre-fill from env keys.
 */
function generateConfigContent(): string {
  const lines: string[] = [
    "# PRAANA Configuration",
    "# https://github.com/amitkumardubey/praana",
    "",
    "[llm]",
    "# Uncomment and set your provider and model",
    "# provider = \"openrouter\"",
    "# model = \"deepseek/deepseek-v4-flash:free\"",
    "",
    "# Or run: praana setup  (guided provider + key collection)",
    "",
    "# Supported providers:",
  ];

  for (const { name, envKey } of formatProviderListForDisplay()) {
    lines.push(`#   ${name.padEnd(20)} → ${envKey ?? "(local)"}`);
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

  const content = generateConfigContent();

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

    // Show a preview of the first few changed lines in interactive mode when not forcing
    if (isInteractiveTerminal() && !opts.force) {
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

    let message =
      `Created config template at ${configPath}\n` +
      `Run \`praana setup\` for guided provider + key collection, or edit the file manually.`;
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
