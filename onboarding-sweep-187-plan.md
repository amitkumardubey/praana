# Onboarding Experience Sweep — Issue #187

## Context

Issue #187 is an umbrella for remaining onboarding friction after the initial first-run fixes (#101, #102, #104). A code audit found 37 friction points. Additionally, the user wants PRAANA to support **all pi-ai providers** (33+ `KnownProvider` types) plus PRAANA-specific providers like `umans` — not just the curated 13 in `PROVIDER_REGISTRY`.

The runtime already handles pi-ai providers: `buildFromPiAiCatalog()` (`llm.ts:170-196`), `isProviderAvailable()` (`llm.ts:106-130`), and `getMissingKeyMessage()` (`llm.ts:132-147`) all fall through to pi-ai for non-registry providers. The gap is the onboarding layer: detection (`DETECTION_PRECEDENCE` only lists 13), display (`listKnownProviders()` only returns 13), and defaults (`DEFAULT_MODELS` only covers 13).

Design: pi-ai as base layer + `PROVIDER_REGISTRY` as PRAANA-specific overlay (custom baseUrl, headers, env keys, detection precedence, default models). This matches omp's dual-half design (catalog table + pi-ai auth registry).

## Approach

Ordered: provider model (foundation) → unified display → unified init flow → first-run detection → messaging → CLI → visibility → guards.

---

### Step 1 — Unify provider list: pi-ai base + PROVIDER_REGISTRY overlay

`listKnownProviders()` (`llm.ts:97-99`) returns only `PROVIDER_REGISTRY` keys. Three hardcoded display copies diverge: `main.ts:77`, `interactive-setup.ts:60-70`, `init.ts:44-56`. Fix both: make `listKnownProviders()` return the union, and derive all display from it.

**1a.** In `src/llm.ts`, change `listKnownProviders()` (line 97-99) to return the union of `PROVIDER_REGISTRY` keys and pi-ai's `getProviders()`, deduplicated and sorted:

```ts
export function listKnownProviders(): string[] {
  const registryIds = Object.keys(PROVIDER_REGISTRY);
  const piAiIds = getProviders() as string[];
  return Array.from(new Set([...registryIds, ...piAiIds])).sort();
}
```

**1b.** Add `formatProviderListForDisplay()` to `src/provider-registry.ts`:

```ts
export function formatProviderListForDisplay(): { name: string; envKey: string | null }[]
```

Returns entries for every provider from `listKnownProviders()` (import from `./llm.js`). For each: look up `envKey` via `getProviderEnvKey(provider)` — which checks `PROVIDER_REGISTRY` first, then falls back to `findEnvKeys(provider)` from pi-ai. If both return null (keyless), display `null`. Sorted alphabetically.

**1c.** In `src/init.ts:generateConfigContent()` (lines 38-57), replace the static comment block with a loop over `formatProviderListForDisplay()`. Each line: `#   ${name.padEnd(20)} → ${envKey ?? "(local)"}`.

**1d.** In `src/interactive-setup.ts:59-71`, replace the hardcoded numbered list with a loop over `formatProviderListForDisplay()`. Number them 1..N dynamically.

**1e.** In `src/main.ts:73-78` (non-TTY no-key message), replace the hardcoded "also:" list. Build it dynamically: for each provider in `formatProviderListForDisplay()` where `envKey !== null`, collect the env key names, comma-separated. This includes pi-ai providers like `CEREBRAS_API_KEY`, `NVIDIA_API_KEY`, `HUGGINGFACE_HUB_TOKEN`, etc.

**Edge:** `amazon-bedrock` shows as `(uses AWS credentials)` — `findEnvKeys("amazon-bedrock")` returns undefined (pi-ai intentionally excludes ambient credential sources), and `PROVIDER_REGISTRY` has `envKey: null`. `ollama` is not in pi-ai's `KnownProvider` type but IS in `PROVIDER_REGISTRY` with `envKey: null`. Both display as `(local)`.

---

### Step 2 — Two-phase provider auto-detection

`detectProviderFromEnvironment()` (`llm.ts:60-75`) only iterates `DETECTION_PRECEDENCE` — a static list of 13 providers. Pi-ai providers like `cerebras`, `nvidia`, `huggingface`, `moonshotai` are never auto-detected even if their keys are set.

**2a.** In `src/llm.ts`, change `detectProviderFromEnvironment()` (lines 60-75) to two-phase:

```ts
export function detectProviderFromEnvironment(): { provider: string; model: string } | null {
  const logger = getAppLogger().child("llm");

  // Phase 1: curated precedence (PRAANA-specific ordering + keyless providers)
  for (const provider of DETECTION_PRECEDENCE) {
    if (isProviderAvailable(provider)) {
      const model = DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
      logger.info(`Auto-detected provider "${provider}" from environment`, { details: { provider, model } });
      return { provider, model };
    }
  }

  // Phase 2: remaining pi-ai providers not already checked
  const checked = new Set(DETECTION_PRECEDENCE);
  for (const provider of (getProviders() as string[])) {
    if (checked.has(provider)) continue;
    if (isProviderAvailable(provider)) {
      const model = DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
      logger.info(`Auto-detected provider "${provider}" from environment`, { details: { provider, model } });
      return { provider, model };
    }
  }

  logger.debug("No provider API key found in environment");
  return null;
}
```

**2b.** Add `pickFirstCatalogModel()` helper in `src/llm.ts`:

```ts
function pickFirstCatalogModel(provider: string): string | undefined {
  const piProvider = mapProviderToPiAi(provider);
  if (!piProvider) return undefined;
  const models = getModels(piProvider as never);
  return models?.[0]?.id;
}
```

Import `getModels` from `@earendil-works/pi-ai/compat` (already exports `getModel`; `getModels` is exported from the same module — confirmed in `compat.d.ts:34`).

**2c.** Update `DETECTION_PRECEDENCE` (`llm.ts:25-38`) to add `umans` and `amazon-bedrock`:

```ts
const DETECTION_PRECEDENCE: string[] = [
  "anthropic", "openai", "deepseek", "groq",
  "google", "mistral", "xai", "fireworks",
  "together", "opencode", "umans", "openrouter",
  "amazon-bedrock",  // AWS credentials (envKey: null, special check in isProviderAvailable)
  "ollama",          // local, no key (PRAANA-specific, not in pi-ai)
];
```

`amazon-bedrock` is in pi-ai's `KnownProvider` and in `PROVIDER_REGISTRY`. `umans` is PRAANA-specific. `ollama` is PRAANA-specific (not in pi-ai at all). Phase 2 covers the remaining 20+ pi-ai providers.

**Edge:** `pickFirstCatalogModel()` may return a model the user doesn't want (e.g. an expensive model). This is a default, not a commitment — the user can override with `PRAANA_MODEL` or config. The alternative (no default, force user to pick) is worse for first-run UX. If `getModels()` returns empty or undefined, model is `""` — `validateConfig()` will warn via Step 8.

---

### Step 3 — Add `umans` provider to `PROVIDER_REGISTRY`

Umans Code (`app.umans.ai/offers/code/docs`) is an OpenAI-compatible endpoint serving open-weight coding models. Not in pi-ai's `KnownProvider` — PRAANA's `buildModel` fallback path (`llm.ts:198-237`) handles it via `PROVIDER_REGISTRY`, same as `opencode` and `together`.

**3a.** In `src/provider-registry.ts`, add to `PROVIDER_REGISTRY` (alphabetical, after `together`):

```ts
umans: {
  api: "openai-completions",
  provider: "umans",
  envKey: "UMANS_AI_CODING_PLAN_API_KEY",
  baseUrl: "https://api.code.umans.ai/v1",
},
```

Env var name matches omp's convention (confirmed at `pi-catalog/src/provider-models/descriptors.ts:360-365`).

**3b.** In `src/llm.ts:DEFAULT_MODELS` (line 41-54), add:

```ts
umans: "umans-coder",
```

**3c.** In `src/config.ts` `validateConfig()` summarizer map (line 280-293), add `umans: "openrouter"`.

**3d.** Add `"umans"` to `REASONING_MODEL_HINTS` in `src/provider-registry.ts` (line 142-147). The default `umans-coder` routes to Kimi K2.7-Code which "always thinks before answering" (per Umans docs). The global hint `/kimi-k2/i` matches `umans-kimi-k2.7` but NOT `umans-coder`:

```ts
umans: [{ pattern: /umans-coder/i }, { pattern: /umans-kimi/i }],
```

Without this, `inferReasoningModel("umans", "umans-coder")` returns false, `getReasoningEffort()` returns undefined, and thinking is never passed on the wire.

**3e.** Do NOT add `"umans"` to `LIVE_CATALOG_PROVIDER_IDS` — Umans exposes `/v1/models/info` (custom format with pricing/capabilities), not the standard OpenAI `/v1/models` that `provider-catalog.ts:fetchProviderCatalogFresh()` fetches. Context window falls back to `DEFAULT_MODEL_CONTEXT_WINDOW` (128K) — same pre-existing limitation as ollama. The real context window (256K) is a future enhancement.

**3f.** Do NOT add `umans` to `PI_AI_PROVIDER_MAP` in `src/model-context.ts`. `mapProviderToPiAi()` returns null, `buildFromPiAiCatalog()` returns null, `buildModel()` uses the `PROVIDER_REGISTRY` fallback. Correct — same as `opencode`.

---

### Step 4 — Fix `amazon-bedrock` `isProviderAvailable` (F13)

`provider-registry.ts:102-108` registers `amazon-bedrock` with `envKey: null`. `isProviderAvailable()` (`llm.ts:110`) returns `true` for all `envKey === null` providers — meaning bedrock is always "available" even without AWS credentials. A user with no keys at all would get bedrock detected, bypass the no-key flow, and hit an auth error on first turn.

**4a.** In `src/llm.ts:isProviderAvailable()` (lines 106-130), add a special case for bedrock before the generic `envKey === null` check:

```ts
if (provider === "amazon-bedrock") {
  return !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_SESSION_TOKEN);
}
```

This mirrors pi-ai's own bedrock auth (`providers/amazon-bedrock.js:14-27`) which checks `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, ECS task role, and web identity token. PRAANA checks the three most common env-var sources; profile/IAM users are advanced enough to configure manually.

**4b.** Add `DEFAULT_MODELS["amazon-bedrock"]` in `src/llm.ts:41-54`:

```ts
"amazon-bedrock": "anthropic.claude-sonnet-4-20250514-v1:0",
```

---

### Step 5 — Unify init and interactive-setup config writes (F25, F34)

`handleInit` writes `~/.praana/config.toml` (global); `runInteractiveSetup` writes `<cwd>/praana.config.toml` (local). Unify on global.

**5a.** In `src/interactive-setup.ts:138`, change `resolve(cwd, "praana.config.toml")` to `appHomePath("config.toml")` from `src/app-identity.ts`. Import `appHomePath`.

**5b.** In `src/interactive-setup.ts:140-142` (config-already-exists branch), offer overwrite: ask "Config already exists. Overwrite? (y/n)" and proceed if yes.

**5c.** In `src/main.ts:58-61`, when `setupResult.success` is false, add before exit:

```ts
console.error("");
console.error("You can also run:  praana init");
console.error("This creates a config template you can edit manually.");
```

---

### Step 6 — Fix post-setup "key still not detected" messaging (F37)

`main.ts:62-71` re-checks the key after interactive setup and prints `"Key still not detected. Please set the environment variable and restart."` — implies user error.

**6a.** Replace `main.ts:65-68` with:

```ts
console.error("");
console.error("Almost there! To finish setup:");
console.error(`  1. Set your key:  export ${getProviderEnvKey(newConfig.llm.provider) ?? "YOUR_API_KEY"}=<your-key>`);
console.error("  2. Restart:       praana");
console.error("");
```

Import `getProviderEnvKey` from `./llm.js`. If `newConfig.llm.provider` is empty or `getProviderEnvKey` returns null (keyless provider), fall back to the generic message.

---

### Step 7 — First-run detection and welcome banner (F6, F15)

**7a.** Add `isFirstRun()` and `markInitialized()` to `src/app-identity.ts`:

```ts
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

export function isFirstRun(): boolean {
  return !existsSync(appHomePath(".initialized"));
}

export function markInitialized(): void {
  mkdirSync(appHomePath(), { recursive: true });
  writeFileSync(appHomePath(".initialized"), new Date().toISOString());
}
```

**7b.** In `src/main.ts`, after the provider validation block (after line 83, before TTY guard), add:

```ts
if (isFirstRun()) {
  markInitialized();
  if (isInteractive) {
    console.log("");
    console.log("  Welcome to PRAANA! This is your first session.");
    console.log("  Memory and embedding models will be set up automatically.");
    console.log("  Run /help anytime, or praana doctor to check your setup.");
    console.log("");
  }
}
```

Import `isFirstRun, markInitialized` from `./app-identity.js`.

---

### Step 8 — Surface config validation warnings to terminal (F7)

`configWarn()` (`config.ts:15-20`) only logs to file.

**8a.** Add module-level `_configWarnings: string[]` in `src/config.ts`. In `configWarn()`, push to array in addition to logger call.

**8b.** Add `export function getConfigWarnings(): string[]` that returns and clears the array.

**8c.** In `src/main.ts`, after `loadConfig()` (line 35):

```ts
const warnings = getConfigWarnings();
if (warnings.length > 0) {
  console.error("");
  console.error("Configuration warnings:");
  for (const w of warnings) console.error(`  ⚠ ${w}`);
  console.error("");
}
```

Import `getConfigWarnings` from `./config.js`.

---

### Step 9 — Remove broken global model fallback (config.ts:271)

`config.ts:271` has `?? "deepseek/deepseek-v4-flash:free"` as a catch-all when a provider isn't in `DEFAULT_MODELS`. Sends an OpenRouter model id to a non-OpenRouter API.

**9a.** In `src/config.ts:268-274`, change the fallback. If provider is set but model is empty and the provider isn't in `DEFAULT_MODELS`, leave model empty and emit `configWarn`:

```ts
if (!out.llm.model || !out.llm.model.trim()) {
  if (out.llm.provider) {
    const defaultModel = DEFAULT_MODELS[out.llm.provider];
    if (defaultModel) {
      out.llm.model = defaultModel;
    } else {
      configWarn(`No default model for provider "${out.llm.provider}". Set [llm] model = "..." in your config.`);
    }
  }
}
```

For pi-ai providers, `detectProviderFromEnvironment()` (Step 2) already picks a first catalog model, so `DEFAULT_MODELS` is only empty for exotic providers. The warning guides the user.

---

### Step 10 — Guard the `"no-key"` literal (F12)

`llm.ts:188` sets `apiKey = getEnvApiKey(piProvider) ?? "no-key"`. If the env var is set-but-empty (`VAR=`), `"no-key"` gets sent upstream.

**10a.** In `src/llm.ts:buildFromPiAiCatalog()` (line 188), change `?? "no-key"` to `?? ""`. Empty string causes pi-ai to throw a clear auth error.

**10b.** In `src/llm.ts:buildModel()` (line 210), the keyless path `: "no-key"` is fine — ollama and bedrock don't use the apiKey. Leave as-is.

---

### Step 11 — Add `--version` flag and `praana doctor` command

**11a.** In `src/cli-args.ts`, add `versionMode: boolean` and `doctorMode: boolean` to `CliArgs`. Parse `--version`/`-v` and `doctor` subcommand (like `init`).

**11b.** In `src/main.ts`, after help check (line 19), before `initAppLogFile()`:

```ts
if (parsed.versionMode) {
  console.log(`${APP_NAME} ${APP_VERSION}`);
  process.exit(0);
}
```

Import `APP_NAME` from `./app-identity.js`, `APP_VERSION` from `./app-banner.js`.

**11c.** Create `src/doctor.ts` with `handleDoctor(config: PraanaConfig): { success: boolean; lines: string[] }`. Checks: provider configured (`getMissingKeyMessage`), model set, memory DB writable (`mkdirSync` catch EACCES), embedder available (`isTransformersAvailable()`), `~/.praana/` exists, config warnings (`getConfigWarnings()`).

**11d.** In `src/main.ts`, after `initMode` block (line 32), add:

```ts
if (parsed.doctorMode) {
  const result = handleDoctor(config);
  for (const line of result.lines) console.log(line);
  process.exit(result.success ? 0 : 1);
}
```

`doctor` runs after `loadConfig` (needs config), unlike `init`.

**11e.** Update `src/app-banner.ts:usageLines()` (lines 74-88) to add `praana --version` and `praana doctor`.

---

### Step 12 — Surface memory init failures (F19, F24)

`session.ts:198-215` swallows memory init errors.

**12a.** Add `memoryInitError: string | null` field to `Session` class. Set in catch at line 198 and resume catch at line 302.

**12b.** In `src/app-controller.ts:start()` (around line 65), add to `bannerLines`:

```ts
if (this.session.memoryInitError) {
  bannerLines.push(`⚠ memory disabled: ${this.session.memoryInitError}`);
}
```

**12c.** In the catch block, detect permission errors:

```ts
const msg = (err as Error).message;
if (msg.includes("EACCES") || msg.includes("permission")) {
  session.memoryInitError = `Cannot write to ~/.praana/. Check permissions or set PRAANA_HOME.`;
} else {
  session.memoryInitError = msg;
}
```

---

### Step 13 — Add `PRAANA_HOME` env override (F24)

**13a.** In `src/app-identity.ts`, modify `appHomePath()`:

```ts
export function appHomePath(...parts: string[]): string {
  const praanaHome = envOverride("PRAANA_HOME");
  if (praanaHome) return join(praanaHome, ...parts);
  return join(homedir(), APP_HOME_DIR, ...parts);
}
```

Full-path override: `PRAANA_HOME=/tmp/praana` → all data under `/tmp/praana/`. `resolveDefaultMemoryDbPath()` and `resolveDefaultSessionLogDir()` call `appHomePath()`, so covered.

**13b.** Update `src/init.ts:handleInit()` line 88:

```ts
const appHomeDir = opts.homeDir ? join(opts.homeDir, APP_HOME_DIR) : appHomePath();
```

---

### Step 14 — Handle resume of non-existent session gracefully (F20)

`session.ts:229-231` throws `Session ${sessionId} not found.` — bubbles up to `main.ts:97-100` with no guidance.

**14a.** In `src/main.ts:96-102`, catch the "not found" case:

```ts
} catch (err) {
  const msg = (err as Error).message;
  if (msg.includes("not found")) {
    console.error(`Session not found: ${parsed.sessionId}`);
    console.error("");
    console.error("List available sessions with:  praana");
    console.error("Then resume with:  praana resume <session-id>");
  } else {
    getAppLogger().error("Failed to start session", { code: "SESSION_START_FAILED", cause: err as Error });
    console.error(`Failed to start session: ${msg}`);
  }
  process.exit(1);
}
```

---

### Step 15 — SIGINT handler and input hints for interactive setup (F31, F35, F36)

**15a.** In `src/interactive-setup.ts`, add SIGINT handler before readline questions:

```ts
const sigintHandler = () => {
  console.error("\n\nSetup cancelled. Run praana init to create a config manually.");
  rl.close();
  process.exit(130);
};
process.on("SIGINT", sigintHandler);
```

Remove in `finally`: `process.removeListener("SIGINT", sigintHandler)`.

**15b.** Add hint after banner (line 46):

```ts
console.error("  Type a number to choose a provider, or 'q' to quit.");
console.error("");
```

**15c.** Improve invalid-choice handling (lines 95-101): wrap choice logic in `while (true)` loop that re-prompts on invalid input instead of returning.

---

### Step 16 — Improve embedder download messaging (F16)

`transformers-embedder.ts:loadPipeline()` (line 82) starts the spinner only when the first `progress_callback` fires — there's a gap before that.

**16a.** In `src/memory/transformers-embedder.ts:loadPipeline()`, start spinner immediately before `await mod.pipeline()` (line 82):

```ts
if (process.stderr.isTTY) {
  startSpinner("Loading embedding model…");
  spinnerStarted = true;
}
```

---

### Step 17 — AGENTS.md template, truncation notice, and advertising (F23, F27, F18)

**17a.** In `src/init.ts:handleInit()`, after writing config (line 112), create `~/.praana/AGENTS.md` if it doesn't exist:

```ts
const agentsPath = join(appHomeDir, "AGENTS.md");
if (!existsSync(agentsPath)) {
  const agentsTemplate = `# Personal Instructions\n\n# Add your global preferences, coding style, or context here.\n# This file is loaded into every PRAANA session.\n`;
  writeFileSync(agentsPath, agentsTemplate, "utf-8");
}
```

Update init success message to mention AGENTS.md when created.

**17b.** In `src/session.ts:loadAgentsContext()`, when truncation occurs, log via `getAppLogger().child("session").notice(...)`.

**17c.** In the first-run welcome banner (Step 7b), add: `console.log("  Tip: Add personal instructions to ~/.praana/AGENTS.md");`

**17d.** In `src/app-banner.ts:getHelpLines()` and `printHelp()`, add: `Tip: ~/.praana/AGENTS.md — global personal instructions loaded every session`

---

### Step 18 — Add `/init` slash command (F4)

**18a.** In `src/slash-commands.ts`, add `/init` command calling `handleInit()` and displaying result. Follow the existing `/memory dedupe` pattern.

**18b.** Add `/init` to help text in `src/app-banner.ts:getHelpLines()` and `printHelp()`.

---

### Step 19 — `--home-dir` CLI flag and `--force` diff preview (F29, F30, F28)

**19a.** In `src/cli-args.ts`, add `homeDir?: string` to `CliArgs`. Parse `--home-dir`/`-H`:

```ts
if ((args[i] === "--home-dir" || args[i] === "-H") && args[i + 1]) {
  homeDir = args[i + 1];
  i++;
  continue;
}
```

**19b.** In `src/main.ts`, pass `parsed.homeDir` to `handleInit`:

```ts
const result = handleInit({ force: parsed.force, homeDir: parsed.homeDir });
```

**19c.** In `src/init.ts:handleInit()`, when `opts.force` and config exists, read existing content, show first 5 changed lines, ask "Overwrite? (y/n)" in interactive mode. Non-interactive: skip preview, proceed.

---

### Step 20 — Announce `~/.praana/` creation (F5, F17)

**20a.** In `src/main.ts`, tied to `isFirstRun()` check (Step 7b), add:

```ts
console.log("  Created ~/.praana/ for config, sessions, and memory.");
```

---

## Critical files & anchors

- `src/llm.ts` — `DETECTION_PRECEDENCE` (line 25), `DEFAULT_MODELS` (line 41), `detectProviderFromEnvironment` (line 60), `listKnownProviders` (line 97), `isProviderAvailable` (line 106), `buildFromPiAiCatalog` (line 170): two-phase detection, union list, no-key guard.
- `src/provider-registry.ts` — `PROVIDER_REGISTRY` (line 22), `REASONING_MODEL_HINTS` (line 142), `LIVE_CATALOG_PROVIDER_IDS` (line 156): umans entry, reasoning hints, display helper.
- `src/config.ts` — `configWarn` (line 15), `validateConfig` (line 260, line 271 global fallback): warning surfacing, model fallback removal.
- `src/main.ts` — `main()` (line 14): orchestration of all onboarding paths.
- `src/app-identity.ts` — `appHomePath` (line 15): `PRAANA_HOME` override, first-run detection.

## Verification

### Build & typecheck
```bash
bun typecheck
```

### Existing tests
```bash
bun test tests/init.test.ts tests/cli-args.test.ts tests/provider-auto-detect.test.ts tests/llm.test.ts tests/bin-entry.test.ts
```

### Full suite
```bash
bun test
```

### New behavior checks (working directory: `~/projects/experiments/praana`)

**1. Union provider list includes pi-ai providers:**
```bash
bun -e "import { listKnownProviders } from './src/llm.ts'; console.log(listKnownProviders().join(', '))"
# Expected: includes anthropic, cerebras, github-copilot, huggingface, nvidia, moonshotai, umans, etc.
```

**2. Umans provider auto-detection:**
```bash
UMANS_AI_CODING_PLAN_API_KEY=sk-test \
  env -u OPENROUTER_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  bun run src/main.ts doctor
# Expected: ✓ provider: umans, model: umans-coder
```

**3. Pi-ai provider auto-detection (cerebras):**
```bash
CEREBRAS_API_KEY=test \
  env -u OPENROUTER_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  bun run src/main.ts doctor
# Expected: ✓ provider: cerebras, model: <first cerebras model from pi-ai catalog>
```

**4. Bedrock auto-detection with AWS creds:**
```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  env -u OPENROUTER_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  bun run src/main.ts doctor
# Expected: provider shows amazon-bedrock
```

**5. `--version` flag:**
```bash
bun run src/main.ts --version
# Expected: PRAANA <version>
```

**6. First-run welcome:**
```bash
rm -rf /tmp/praana-firstrun
PRAANA_HOME=/tmp/praana-firstrun ANTHROPIC_API_KEY=test bun run src/main.ts
# Expected: "Welcome to PRAANA!" message on first run; none on second
```

**7. Config warnings to terminal:**
```bash
printf '[compiler]\ntoken_budget = 50\n' > /tmp/test-config.toml
bun run src/main.ts --config /tmp/test-config.toml 2>&1 | grep "Configuration warnings"
# Expected: ⚠ Invalid compiler.token_budget
```

**8. Global model fallback removed:**
```bash
printf '[llm]\nprovider = "cerebras"\n' > /tmp/test-cerebras.toml
bun run src/main.ts --config /tmp/test-cerebras.toml doctor 2>&1 | grep -i "model"
# Expected: model is set (from pi-ai catalog), not "deepseek/deepseek-v4-flash:free"
```

**9. Interactive setup writes to global config:**
```bash
# In a TTY, run with no key, pick a provider, say yes to config
# Verify config is at ~/.praana/config.toml, not ./praana.config.toml
```

## Assumptions & contingencies

- **`PRAANA_HOME` as full path override**: replaces the entire `~/.praana` path. If the user prefers `homedir()` override (so `PRAANA_HOME=/tmp` → `/tmp/.praana`), adjust `appHomePath()`. Current design: full path (simpler for containers).
- **Bedrock `isProviderAvailable` check**: checks `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `AWS_SESSION_TOKEN`. Users relying on `~/.aws/credentials` or IAM role without env vars must set `provider = "amazon-bedrock"` in config. Acceptable — env-var detection covers the common case.
- **`pickFirstCatalogModel()` may pick an expensive model**: the first model in pi-ai's `getModels()` array is provider-defined ordering, not cost-optimized. This is a default, not a commitment. The alternative (no default, force user to pick) is worse for first-run UX. Users can override with `PRAANA_MODEL` or config.
- **`--force` diff preview scope**: shows first 5 changed lines. A full diff would require a diff library. Simple approach is sufficient for "don't silently nuke edits."
- **If `@huggingface/transformers` is not installed**: spinner starts then immediately stops when `loadTransformersModule()` returns null. `tryTransformersEmbedder` returns null, user gets keyword-only warning from `embedder-factory.ts:50`.
- **`/init` slash command**: `handleInit` is synchronous and non-interactive. The `/init` slash command calls it directly — no `--force` prompt in-session. If config exists, returns `action: "skipped"` and user sees the message. Correct for in-session use.
- **Pi-ai compat layer deprecation**: the compat module (`@earendil-works/pi-ai/compat`) is marked deprecated ("deleted with the coding-agent ModelManager migration"). If pi-ai removes it, PRAANA must migrate to `createModels()` / `Models.getModel()` API. All pi-ai imports in this plan (`getProviders`, `getModels`, `getModel`, `getEnvApiKey`, `findEnvKeys`) come from compat. Contingency: when compat is removed, replace with the new API surface. Not blocking now — compat is present in pi-ai 0.80.3.
