import * as readline from "node:readline";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { getAppLogger } from "../logger.js";
import { askQuestion } from "../terminal.js";
import {
  buildProviderSelectItems,
  formatDetectedProviderLines,
  CUSTOM_PROVIDER_VALUE,
  findProviderSelectItem,
  type SelectItem,
} from "./provider-options.js";
import { getSetupConfigPath } from "./config-writer.js";
import {
  saveProviderKey,
  fetchProviderModels,
  fetchCustomProviderModels,
  pickDefaultModel,
  finalizeProviderSetup,
  setupConfigConfirmPrompt,
  isValidCustomProviderId,
  isValidBaseUrl,
  formatEnvKeyOfferMessage,
  adoptEnvKeyForProvider,
  providerRequiresApiKey,
  providerSupportsOAuth,
  bedrockNeedsApiKeyPrompt,
} from "./logic.js";
import { hasApiKey, isProviderAvailable } from "../llm.js";
import { isOAuthOnlyProvider } from "../oauth.js";
import type { SetupResult, CustomProviderConfig } from "./types.js";
import type { ProviderCatalogModelEntry } from "../provider-catalog.js";

/**
 * Readline-based setup fallback when pi-tui is unavailable.
 * Mirrors the TUI wizard flow: provider pick → key entry → model pick → config write.
 */
export async function runInteractiveSetupCli(_cwd: string): Promise<SetupResult> {
  const logger = getAppLogger().child("app");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const sigintHandler = () => {
    console.error("\n\nSetup cancelled. Run `praana setup` again, or edit `~/.praana/config.toml` manually.");
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
    console.log("No provider configured. Let's set one up.");
    console.log("");

    const detectedLines = formatDetectedProviderLines();
    for (const line of detectedLines) {
      console.log(line);
    }
    if (detectedLines.length > 0) console.log("");

    // ── Provider selection ──
    const items = buildProviderSelectItems();
    console.log("Available providers:");
    console.log("");
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const desc = item.description ? ` — ${item.description}` : "";
      console.log(`  ${i + 1}. ${item.label}${desc}`);
    }
    console.log("");

    let selectedItem: SelectItem | null = null;
    while (!selectedItem) {
      const choice = await askQuestion(rl, "Which provider? (number/name, 'q' to quit): ");
      const lower = choice.toLowerCase().trim();

      if (lower === "q" || lower === "quit") {
        return { success: false, message: "Setup cancelled." };
      }

      const choiceNum = parseInt(choice, 10);
      if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= items.length) {
        selectedItem = items[choiceNum - 1];
      } else {
        const match = findProviderSelectItem(items, lower);
        if (match) {
          selectedItem = match;
        } else {
          console.error(`Invalid choice: "${choice}". Try again.`);
        }
      }
    }

    const isCustom = selectedItem.value === CUSTOM_PROVIDER_VALUE;
    let providerId = "";
    let customBaseUrl = "";
    let keySaved = false;
    let apiKey: string | undefined;

    // ── Key / custom provider collection ──
    if (isCustom) {
      console.log("");
      console.log("Custom OpenAI-compatible endpoint");
      console.log("");

      // Provider id
      while (true) {
        const idInput = await askQuestion(rl, "Provider id (lowercase, e.g. my-llama): ");
        const validation = isValidCustomProviderId(idInput.trim());
        if (validation.valid) {
          providerId = idInput.trim();
          break;
        }
        console.error(`✗ ${validation.error}`);
      }

      // Base URL
      while (true) {
        const urlInput = await askQuestion(rl, "Base URL (e.g. http://localhost:8080/v1): ");
        const validation = isValidBaseUrl(urlInput.trim());
        if (validation.valid) {
          customBaseUrl = urlInput.trim();
          break;
        }
        console.error(`✗ ${validation.error}`);
      }

      // API key (optional)
      const keyInput = await askQuestion(rl, "API key (Enter to skip for keyless servers): ");
      if (keyInput.trim()) {
        saveProviderKey(providerId, keyInput.trim());
        apiKey = keyInput.trim();
        keySaved = true;
      }
    } else {
      providerId = selectedItem.value;
      console.log("");
      console.log(`Selected: ${providerId}`);

      if (providerId === "amazon-bedrock") {
        if (bedrockNeedsApiKeyPrompt()) {
          while (true) {
            const keyInput = await askQuestion(
              rl,
              "Paste your Bedrock API key (bearer token): ",
            );
            if (keyInput.trim()) {
              saveProviderKey(providerId, keyInput.trim());
              keySaved = true;
              break;
            }
            console.error(
              "✗ Bedrock API key is required when AWS credentials are not detected",
            );
          }
        } else if (isProviderAvailable(providerId)) {
          console.log(chalk.green("✓ AWS credentials or Bedrock API key detected."));
        }
      } else if (providerSupportsOAuth(providerId) && isOAuthOnlyProvider(providerId)) {
        console.log(
          chalk.yellow(
            `  ${providerId} uses OAuth. Run \`praana\` then \`/login ${providerId}\` in the TUI to sign in.`,
          ),
        );
        if (!isProviderAvailable(providerId)) {
          console.log(
            chalk.yellow(
              "  Continuing without credentials — the next turn will fail until you sign in.",
            ),
          );
        }
      } else {
      const requiresKey = providerRequiresApiKey(providerId);
      const promptForKey = async (): Promise<boolean> => {
        while (true) {
          const keyInput = await askQuestion(rl, "Paste your API key: ");
          if (keyInput.trim()) {
            saveProviderKey(providerId, keyInput.trim());
            return true;
          }
          if (!requiresKey) {
            console.log(chalk.yellow("  No key entered. Continuing without a stored key."));
            return false;
          }
          console.error("✗ API key is required for this provider");
        }
      };

      if (hasApiKey(providerId)) {
        console.log(chalk.green("✓ API key detected in credential store."));
        const replace = await askQuestion(rl, "Replace with a new key? (y/n): ");
        if (replace.toLowerCase() === "y" || replace.toLowerCase() === "yes") {
          keySaved = await promptForKey();
        }
      } else {
        const envOffer = formatEnvKeyOfferMessage(providerId);
        if (envOffer) {
          const useEnv = await askQuestion(rl, `${envOffer} (y/n): `);
          if (useEnv.toLowerCase() === "y" || useEnv.toLowerCase() === "yes") {
            keySaved = adoptEnvKeyForProvider(providerId);
          } else {
            keySaved = await promptForKey();
          }
        } else {
          keySaved = await promptForKey();
        }
      }
      }
    }

    // ── Model fetch + picker ──
    let model: string | undefined;
    console.log("");
    console.log("Fetching models…");

    let models: ProviderCatalogModelEntry[] | null = null;
    try {
      if (isCustom) {
        models = await fetchCustomProviderModels(customBaseUrl, apiKey);
      } else {
        models = await fetchProviderModels(providerId);
      }
    } catch {
      models = null;
    }

    if (models && models.length > 0) {
      console.log("");
      console.log("Available models:");
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k ctx)` : "";
        console.log(`  ${i + 1}. ${m.id}${ctx}`);
      }
      console.log("");

      const modelChoice = await askQuestion(
        rl,
        "Pick a default model (number, or Enter for first): ",
      );
      if (modelChoice.trim()) {
        const modelNum = parseInt(modelChoice, 10);
        if (!isNaN(modelNum) && modelNum >= 1 && modelNum <= models.length) {
          model = models[modelNum - 1].id;
        } else {
          model = modelChoice.trim();
        }
      } else {
        model = models[0].id;
      }
    } else {
      console.log("");
      console.log("Could not fetch model list (or provider has no live catalog).");
      const defaultModel = pickDefaultModel(providerId);
      const modelInput = await askQuestion(
        rl,
        defaultModel
          ? `Enter model id (Enter for default: ${defaultModel}): `
          : "Enter model id: ",
      );
      model = modelInput.trim() || defaultModel || undefined;
    }

    // ── Config write ──
    const customProvider: CustomProviderConfig | undefined = isCustom
      ? { id: providerId, api: "openai-completions", baseUrl: customBaseUrl }
      : undefined;

    console.log("");
    const saveToConfig = await askQuestion(
      rl,
      `${setupConfigConfirmPrompt(existsSync(getSetupConfigPath()))} (y/n): `,
    );
    if (saveToConfig.toLowerCase() !== "y" && saveToConfig.toLowerCase() !== "yes") {
      return finalizeProviderSetup(providerId, "skip", {
        model,
        customProvider,
        keySaved,
      });
    }

    const result = finalizeProviderSetup(providerId, "write", {
      model,
      customProvider,
      keySaved,
    });
    logger.info(`Interactive setup completed for provider: ${providerId}`, {
      details: { provider: providerId },
    });
    if (result.success) {
      console.log(`\n✓ ${result.message}`);
    }
    return result;
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    rl.close();
  }
}
