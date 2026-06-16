import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";
import {
  listKnownProviders,
  listAvailableProviders,
  getProviderEnvKey,
  isProviderAvailable,
} from "./llm.js";
import { DEFAULT_MODELS } from "./llm.js";
import { getAppLogger } from "./logger.js";

interface SetupResult {
  success: boolean;
  provider?: string;
  message: string;
}

/**
 * Run interactive provider setup when no API key is found.
 * Guides the user through selecting a provider and setting up their key.
 */
export async function runInteractiveSetup(cwd: string): Promise<SetupResult> {
  const logger = getAppLogger().child("app");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer.trim());
      });
    });
  };

  try {
    console.error("");
    console.error("═══════════════════════════════════════════════════════════════");
    console.error("  PRAANA — Provider Setup");
    console.error("═══════════════════════════════════════════════════════════════");
    console.error("");
    console.error("No provider API key found. Let's set one up.");
    console.error("");

    // Get all known providers (excluding ollama which is always available)
    const allProviders = listKnownProviders().filter((p) => p !== "ollama");
    const available = listAvailableProviders().filter((p) => p !== "ollama");

    if (available.length > 0) {
      console.error("Detected in environment:");
      for (const provider of available) {
        console.error(`  ✓ ${provider}`);
      }
      console.error("");
    }

    console.error("Supported providers:");
    console.error("  1. anthropic    (requires ANTHROPIC_API_KEY)");
    console.error("  2. openai       (requires OPENAI_API_KEY)");
    console.error("  3. deepseek     (requires DEEPSEEK_API_KEY)");
    console.error("  4. groq         (requires GROQ_API_KEY)");
    console.error("  5. google       (requires GOOGLE_GENERATIVE_AI_API_KEY)");
    console.error("  6. mistral      (requires MISTRAL_API_KEY)");
    console.error("  7. xai          (requires XAI_API_KEY)");
    console.error("  8. fireworks    (requires FIREWORKS_API_KEY)");
    console.error("  9. together     (requires TOGETHER_API_KEY)");
    console.error("  10. openrouter  (requires OPENROUTER_API_KEY)");
    console.error("  11. ollama      (local, no key needed)");
    console.error("");

    // Ask which provider
    const providerChoice = await question(
      "Which provider would you like to use? (number or name, or 'q' to quit): "
    );

    if (providerChoice.toLowerCase() === "q" || providerChoice.toLowerCase() === "quit") {
      return {
        success: false,
        message: "Setup cancelled.",
      };
    }

    // Parse provider choice
    let selectedProvider: string | null = null;
    const choiceNum = parseInt(providerChoice, 10);

    if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= allProviders.length) {
      selectedProvider = allProviders[choiceNum - 1];
    } else if (allProviders.includes(providerChoice.toLowerCase())) {
      selectedProvider = providerChoice.toLowerCase();
    }

    if (!selectedProvider) {
      console.error("");
      console.error(`Invalid choice: "${providerChoice}"`);
      return {
        success: false,
        message: "Invalid provider choice.",
      };
    }

    console.error("");
    console.error(`Selected: ${selectedProvider}`);

    // Check if key is already available
    if (isProviderAvailable(selectedProvider)) {
      console.error(`\n✓ ${selectedProvider} API key already detected in environment!`);
      console.error(`\nTo use this provider, run:`);
      console.error(`  export ${getProviderEnvKey(selectedProvider)}=<your-key>`);
      console.error(`\nOr restart PRAANA — it should auto-detect the key.`);
      return {
        success: true,
        provider: selectedProvider,
        message: `Provider ${selectedProvider} is already configured.`,
      };
    }

    // Show the env var to set
    const envKey = getProviderEnvKey(selectedProvider);
    const model = DEFAULT_MODELS[selectedProvider] ?? "default";

    console.error("");
    console.error(`To use ${selectedProvider}, set this environment variable:`);
    console.error("");
    console.error(`  export ${envKey}=<your-api-key>`);
    console.error("");
    console.error(`Then restart PRAANA. It will auto-detect the key.`);
    console.error("");
    console.error(`Default model: ${model}`);
    console.error("");

    // Offer to save to config
    const saveToConfig = await question("Would you like me to create a config file? (y/n): ");

    if (saveToConfig.toLowerCase() === "y" || saveToConfig.toLowerCase() === "yes") {
      const configPath = resolve(cwd, "praana.config.toml");

      if (existsSync(configPath)) {
        console.error(`\nConfig file already exists: ${configPath}`);
        console.error("Please edit it manually to add your provider settings.");
      } else {
        const configContent = `# PRAANA Configuration
# https://github.com/amitkumardubey/praana

[llm]
provider = "${selectedProvider}"
model = "${model}"

# Set your API key as an environment variable:
# export ${envKey}=<your-api-key>
`;

        try {
          writeFileSync(configPath, configContent, "utf-8");
          console.error(`\n✓ Created config file: ${configPath}`);
          console.error(`\nNext steps:`);
          console.error(`  1. Set your API key:  export ${envKey}=<your-api-key>`);
          console.error(`  2. Restart PRAANA:   praana`);
        } catch (err) {
          console.error(`\nFailed to create config file: ${(err as Error).message}`);
          console.error("Please create it manually.");
        }
      }
    } else {
      console.error("");
      console.error("Quick start:");
      console.error(`  1. Set your API key:  export ${envKey}=<your-api-key>`);
      console.error(`  2. Restart PRAANA:   praana`);
    }

    console.error("");
    logger.info(`Interactive setup completed for provider: ${selectedProvider}`, {
      details: { provider: selectedProvider },
    });

    return {
      success: true,
      provider: selectedProvider,
      message: `Setup completed for ${selectedProvider}.`,
    };
  } finally {
    rl.close();
  }
}
