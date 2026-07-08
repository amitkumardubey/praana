import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import * as readline from "node:readline";
import {
  listKnownProviders,
  listAvailableProviders,
  getProviderEnvKey,
  isProviderAvailable,
} from "./llm.js";
import { DEFAULT_MODELS } from "./llm.js";
import { PROVIDER_REGISTRY } from "./provider-registry.js";
import { getAppLogger } from "./logger.js";
import { appHomePath } from "./app-identity.js";

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
    const { promise, resolve } = Promise.withResolvers<string>();
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
    return promise;
  };

  const sigintHandler = () => {
    console.error("\n\nSetup cancelled. Run praana init to create a config manually.");
    rl.close();
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  try {
    console.error("");
    console.error("═══════════════════════════════════════════════════════════════");
    console.error("  PRAANA — Provider Setup");
    console.error("═══════════════════════════════════════════════════════════════");
    console.error("");
    console.error("No provider API key found. Let's set one up.");
    console.error("");

    // Interactive setup only covers providers with first-class PRAANA support
    // (explicit baseUrl, api type, env key, and default model).
    // Pi-ai-only providers are excluded — they have no defaults and would produce broken configs.
    const allProviders = Object.keys(PROVIDER_REGISTRY).sort().filter((p) => p !== "ollama");
    const available = listAvailableProviders().filter(
      (p) => p !== "ollama" && Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, p),
    );

    if (available.length > 0) {
      console.error("Detected in environment:");
      for (const provider of available) {
        console.error(`  ✓ ${provider}`);
      }
      console.error("");
    }
    console.error("Supported providers:");
    for (let i = 0; i < allProviders.length; i++) {
      console.error(`  ${i + 1}. ${allProviders[i]}`);
    }
    console.error("");
    console.error("  Type a number to choose a provider, or 'q' to quit.");
    console.error("");

    let selectedProvider: string | null = null;
    while (selectedProvider === null) {
      const providerChoice = await question(
        "Which provider would you like to use? (number or name, or 'q' to quit): "
      );

      if (providerChoice.toLowerCase() === "q" || providerChoice.toLowerCase() === "quit") {
        return {
          success: false,
          message: "Setup cancelled.",
        };
      }

      const choiceNum = parseInt(providerChoice, 10);
      if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= allProviders.length) {
        selectedProvider = allProviders[choiceNum - 1];
      } else if (allProviders.includes(providerChoice.toLowerCase())) {
        selectedProvider = providerChoice.toLowerCase();
      } else if (listKnownProviders().includes(providerChoice.toLowerCase())) {
        console.error(`  "${providerChoice}" is supported by pi-ai but not yet configured for`);
        console.error(`  interactive setup. Add it manually to ~/.praana/config.toml:`);
        console.error(`    [llm]`);
        console.error(`    provider = "${providerChoice.toLowerCase()}"`);
        console.error(`    model    = "<model-id>"`);
        console.error(``);
      } else {
        console.error(`Invalid choice: "${providerChoice}". Try again.`);
      }
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
    const model = DEFAULT_MODELS[selectedProvider] ?? "";

    console.error("");
    console.error(`To use ${selectedProvider}, set this environment variable:`);
    console.error("");
    console.error(`  export ${envKey}=<your-api-key>`);
    console.error("");
    console.error(`Then restart PRAANA. It will auto-detect the key.`);

    // Offer to save to config
    const saveToConfig = await question("Would you like me to create a config file? (y/n): ");
    if (saveToConfig.toLowerCase() === "y" || saveToConfig.toLowerCase() === "yes") {
      const configPath = appHomePath("config.toml");

      if (existsSync(configPath)) {
        const overwrite = await question(`Config already exists at ${configPath}. Overwrite? (y/n): `);
        if (overwrite.toLowerCase() !== "y" && overwrite.toLowerCase() !== "yes") {
          console.error("\nConfig left unchanged.");
          return {
            success: true,
            provider: selectedProvider,
            message: `Config left unchanged at ${configPath}.`,
          };
        }
      }

      const modelLine = model ? `model = "${model}"\n` : `# model = "<model-id>"  # set this if PRAANA doesn't auto-detect\n`;
      const configContent = `# PRAANA Configuration
# https://github.com/amitkumardubey/praana

[llm]
provider = "${selectedProvider}"
${modelLine}
# Set your API key as an environment variable:
# export ${envKey}=<your-api-key>
`;

      try {
        mkdirSync(appHomePath(), { recursive: true });
        writeFileSync(configPath, configContent, "utf-8");
        console.error(`\n✓ Created config file: ${configPath}`);
        console.error(`\nNext steps:`);
        console.error(`  1. Set your API key:  export ${envKey}=<your-api-key>`);
        console.error(`  2. Restart PRAANA:   praana`);
      } catch (err) {
        console.error(`\nFailed to create config file: ${(err as Error).message}`);
        console.error("Please create it manually.");
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
    process.removeListener("SIGINT", sigintHandler);
    rl.close();
  }
}
