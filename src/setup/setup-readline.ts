import * as readline from "node:readline";
import { existsSync } from "node:fs";
import { getAppLogger } from "../logger.js";
import { getProviderEnvKey } from "../provider-registry.js";
import { askQuestion } from "../terminal.js";
import {
  buildProviderSelectItems,
  formatDetectedProviderLines,
  providerPageLines,
  listSetupProviderIds,
} from "./provider-options.js";
import { getSetupConfigPath } from "./config-writer.js";
import {
  buildProviderInstructions,
  describeProviderSetup,
  finalizeProviderSetup,
} from "./logic.js";
import type { SetupResult } from "./types.js";

const PAGE_SIZE = 10;

/**
 * Readline-based setup fallback when pi-tui is unavailable.
 */
export async function runInteractiveSetupCli(_cwd: string): Promise<SetupResult> {
  const logger = getAppLogger().child("app");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const sigintHandler = () => {
    console.error("\n\nSetup cancelled. Run praana init to create a config manually.");
    rl.close();
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  try {
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  PRAANA — Provider Setup");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("");
    console.log("No provider API key found. Let's set one up.");
    console.log("");

    for (const line of formatDetectedProviderLines()) {
      console.log(line);
    }
    if (formatDetectedProviderLines().length > 0) console.log("");

    const allProviders = listSetupProviderIds();
    console.log("Supported providers:");
    console.log("");

    let page = 0;
    const totalPages = Math.max(1, Math.ceil(allProviders.length / PAGE_SIZE));

    const renderPage = (p: number) => {
      for (const line of providerPageLines(allProviders, p, PAGE_SIZE)) {
        console.log(line);
      }
    };

    renderPage(page);

    let selectedProvider: string | null = null;
    while (selectedProvider === null) {
      const providerChoice = await askQuestion(
        rl,
        "Which provider? (number/name, 'n'/'p' to page, 'q' to quit): ",
      );
      const lower = providerChoice.toLowerCase();

      if (lower === "q" || lower === "quit") {
        return { success: false, message: "Setup cancelled." };
      }

      if ((lower === "n" || lower === "next") && totalPages > 1) {
        if (page < totalPages - 1) {
          page++;
          renderPage(page);
        } else {
          console.error("Already on the last page.");
        }
        continue;
      }

      if ((lower === "p" || lower === "prev" || lower === "previous") && totalPages > 1) {
        if (page > 0) {
          page--;
          renderPage(page);
        } else {
          console.error("Already on the first page.");
        }
        continue;
      }

      const choiceNum = parseInt(providerChoice, 10);
      if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= allProviders.length) {
        selectedProvider = allProviders[choiceNum - 1];
      } else if (allProviders.includes(lower)) {
        selectedProvider = lower;
      } else {
        console.error(`Invalid choice: "${providerChoice}". Try again.`);
      }
    }

    console.log("");
    console.log(`Selected: ${selectedProvider}`);

    const info = describeProviderSetup(selectedProvider);
    for (const line of buildProviderInstructions(info)) {
      console.log(line);
    }

    if (info.needsExternalConfig) {
      return finalizeProviderSetup(selectedProvider, "skip");
    }

    const envKey = getProviderEnvKey(selectedProvider);
    if (!info.keyDetected && envKey) {
      console.log("");
      console.log(`Then restart PRAANA. It will auto-detect ${envKey}.`);
    }

    console.log("");
    const saveToConfig = await askQuestion(rl, "Create ~/.praana/config.toml? (y/n): ");
    if (saveToConfig.toLowerCase() !== "y" && saveToConfig.toLowerCase() !== "yes") {
      console.log("");
      if (envKey && !info.keyDetected) {
        console.log("Quick start:");
        console.log(`  1. Set your API key:  export ${envKey}=<your-api-key>`);
        console.log("  2. Restart PRAANA:   praana");
      }
      return finalizeProviderSetup(selectedProvider, "skip");
    }

    if (existsSync(getSetupConfigPath())) {
      const overwrite = await askQuestion(
        rl,
        `Config already exists at ${getSetupConfigPath()}. Overwrite? (y/n): `,
      );
      if (overwrite.toLowerCase() !== "y" && overwrite.toLowerCase() !== "yes") {
        console.log("\nConfig left unchanged.");
        return finalizeProviderSetup(selectedProvider, "skip");
      }
      const result = finalizeProviderSetup(selectedProvider, "overwrite");
      if (result.message.includes("Created") || result.message.includes("Updated")) {
        console.log(`\n✓ ${result.message}`);
      }
      return result;
    }

    const result = finalizeProviderSetup(selectedProvider, "write");
    logger.info(`Interactive setup completed for provider: ${selectedProvider}`, {
      details: { provider: selectedProvider },
    });
    if (result.message.includes("Created")) {
      console.log(`\n✓ ${result.message}`);
      if (envKey && !info.keyDetected) {
        console.log(`\nNext steps:`);
        console.log(`  1. Set your API key:  export ${envKey}=<your-api-key>`);
        console.log("  2. Restart PRAANA:   praana");
      }
    }
    return result;
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    rl.close();
  }
}
