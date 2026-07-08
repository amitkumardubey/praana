import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import * as readline from "node:readline";
import {
  listKnownProviders,
  listAvailableProviders,
  isProviderAvailable,
  DEFAULT_MODELS,
  pickFirstCatalogModel,
} from "./llm.js";
import { getAppLogger } from "./logger.js";
import { appHomePath } from "./app-identity.js";
import { getProviderEnvKey, SETUP_UNSUPPORTED_PROVIDERS } from "./provider-registry.js";
import { askQuestion } from "./terminal.js";

interface SetupResult {
  success: boolean;
  provider?: string;
  message: string;
}

/**
 * Run interactive provider setup when no API key is found.
 * Guides the user through selecting a provider and setting up their key.
 */
const PAGE_SIZE = 10;

/** Render one page of the provider list as printable lines. */
export function providerPageLines(providers: string[], page: number, pageSize: number): string[] {
  const totalPages = Math.max(1, Math.ceil(providers.length / pageSize));
  const start = page * pageSize;
  const end = Math.min(start + pageSize, providers.length);
  const lines: string[] = [];
  for (let i = start; i < end; i++) {
    lines.push(`  ${i + 1}. ${providers[i]}`);
  }
  lines.push("");
  if (totalPages > 1) {
    lines.push(`  Page ${page + 1}/${totalPages}. Type 'n' for next, 'p' for previous.`);
  }
  return lines;
}

export async function runInteractiveSetup(cwd: string): Promise<SetupResult> {
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

    const allProviders = listKnownProviders().filter((p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p));
    const available = listAvailableProviders().filter((p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p));

    if (available.length > 0) {
      console.log("Detected in environment:");
      for (const provider of available) {
        console.log(`  ✓ ${provider}`);
      }
      console.log("");
    }
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
        "Which provider would you like to use? (number/name, 'n'/'p' to page, 'q' to quit): ",
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

    const envKey = getProviderEnvKey(selectedProvider);
    if (!envKey) {
      console.log("");
      console.log(`Provider ${selectedProvider} does not use a single API key.`);
      console.log("Configure it separately, then restart PRAANA.");
      return {
        success: true,
        provider: selectedProvider,
        message: `Provider ${selectedProvider} skipped interactive setup.`,
      };
    }

    // Check if key is already available
    if (isProviderAvailable(selectedProvider)) {
      console.log(`\n✓ ${selectedProvider} API key already detected in environment!`);
      console.log(`\nTo use this provider, run:`);
      console.log(`  export ${envKey}=<your-key>`);
      console.log(`\nOr restart PRAANA — it should auto-detect the key.`);
      return {
        success: true,
        provider: selectedProvider,
        message: `Provider ${selectedProvider} is already configured.`,
      };
    }

    const model = DEFAULT_MODELS[selectedProvider] ?? pickFirstCatalogModel(selectedProvider) ?? "";

    console.log("");
    console.log(`To use ${selectedProvider}, set this environment variable:`);
    console.log("");
    console.log(`  export ${envKey}=<your-api-key>`);
    console.log("");
    console.log(`Then restart PRAANA. It will auto-detect the key.`);

    // Offer to save to config
    const saveToConfig = await askQuestion(rl, "Would you like me to create a config file? (y/n): ");
    if (saveToConfig.toLowerCase() === "y" || saveToConfig.toLowerCase() === "yes") {
      const configPath = appHomePath("config.toml");

      if (existsSync(configPath)) {
        const overwrite = await askQuestion(rl, `Config already exists at ${configPath}. Overwrite? (y/n): `);
        if (overwrite.toLowerCase() !== "y" && overwrite.toLowerCase() !== "yes") {
          console.log("\nConfig left unchanged.");
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
        console.log(`\n✓ Created config file: ${configPath}`);
        console.log(`\nNext steps:`);
        console.log(`  1. Set your API key:  export ${envKey}=<your-api-key>`);
        console.log(`  2. Restart PRAANA:   praana`);
      } catch (err) {
        console.error(`\nFailed to create config file: ${(err as Error).message}`);
        console.error("Please create it manually.");
      }
    } else {
      console.log("");
      console.log("Quick start:");
      console.log(`  1. Set your API key:  export ${envKey}=<your-api-key>`);
      console.log(`  2. Restart PRAANA:   praana`);
    }

    console.log("");
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
