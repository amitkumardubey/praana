# Amazon Bedrock First-Class Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Amazon Bedrock a first-class PRAANA provider with live AWS chat-model catalog (inference profiles preferred), config/env region, widened credential detection, and setup/login that can store a Bedrock API key (bearer token).

**Architecture:** Keep pi-ai `bedrock-converse-stream` for invoke. Add `src/bedrock/` helpers (region, credentials, catalog). Wire live catalog into `provider-catalog.ts` (control-plane branch, not HTTP `/models`). Pass `region` + `bearerToken` via `RuntimeModel.__piOptions`. Enable Bedrock in setup/login with an ambient-or-prompt-bearer branch.

**Tech Stack:** TypeScript, Bun, `@aws-sdk/client-bedrock`, existing `@earendil-works/pi-ai`, provider-catalog disk cache, credential store.

## Global Constraints

- Invoke stays on pi-ai; do not reimplement ConverseStream.
- Bedrock API key goes in `__piOptions.bearerToken`, never as `apiKey`.
- `llm.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.
- Live catalog: TEXT chat-capable only; hard-exclude `responseStreamingSupported === false`; prefer inference profiles via `foundation-model/` ARN suffix.
- Never log bearer tokens or secret keys.
- Conventional commits; `bun typecheck && bun test` before each commit when practical.
- Update repo docs + `~/win_documents/Github/praana-internal` before commits that change user-facing behavior.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/bedrock/region.ts` | `resolveBedrockRegion` |
| `src/bedrock/credentials.ts` | Ambient AWS + store/env bearer; availability + missing message |
| `src/bedrock/catalog.ts` | Pure filter/prefer + `fetchBedrockLiveCatalog` |
| `src/types.ts` | `LlmConfig.region?: string` |
| `src/config.ts` | Validate/pass through `llm.region` |
| `src/llm.ts` | Use bedrock credentials; set `__piOptions.region` + `bearerToken` |
| `src/provider-registry.ts` | Live catalog id; remove from `SETUP_UNSUPPORTED` |
| `src/provider-catalog.ts` | Bedrock branch in `fetchProviderCatalogFresh` |
| `src/setup/logic.ts` | Optional `needsBedrockBearerPrompt` helper if useful |
| `src/ui/tui/setup-wizard.ts` | Bedrock ambient-or-prompt branch |
| `src/ui/tui/login-wizard.ts` | Same (stop blind `finishKeyless`) |
| `src/setup/setup-readline.ts` | Same for non-TTY setup |
| `tests/bedrock-region.test.ts` | Region precedence |
| `tests/bedrock-credentials.test.ts` | Availability matrix |
| `tests/bedrock-catalog.test.ts` | Filter + prefer fixtures |
| `tests/provider-catalog-bedrock.test.ts` | Mocked fetch → cache |
| `tests/llm.test.ts` | Update existing Bedrock availability tests |
| Docs / example toml | User-facing Bedrock notes |

---

### Task 1: Region resolver + `llm.region` config

**Files:**
- Create: `src/bedrock/region.ts`
- Modify: `src/types.ts` (`LlmConfig`)
- Modify: `src/config.ts` (validation)
- Test: `tests/bedrock-region.test.ts`
- Test: extend `tests/config.test.ts` if it already covers `llm` keys; otherwise keep region tests in `tests/bedrock-region.test.ts` via `loadConfig`

**Interfaces:**
- Consumes: `PraanaConfig["llm"]` shape
- Produces: `resolveBedrockRegion(config?: { region?: string }): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/bedrock-region.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveBedrockRegion } from "../src/bedrock/region.js";

describe("resolveBedrockRegion", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prefers config.region over env", () => {
    process.env.AWS_REGION = "eu-west-1";
    expect(resolveBedrockRegion({ region: "us-west-2" })).toBe("us-west-2");
  });

  it("uses AWS_REGION then AWS_DEFAULT_REGION then us-east-1", () => {
    expect(resolveBedrockRegion()).toBe("us-east-1");
    process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
    expect(resolveBedrockRegion()).toBe("ap-southeast-1");
    process.env.AWS_REGION = "eu-central-1";
    expect(resolveBedrockRegion()).toBe("eu-central-1");
  });

  it("ignores blank config.region", () => {
    process.env.AWS_REGION = "us-east-2";
    expect(resolveBedrockRegion({ region: "  " })).toBe("us-east-2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bedrock-region.test.ts`

Expected: FAIL — cannot resolve `../src/bedrock/region.js`

- [ ] **Step 3: Implement region + config field**

```typescript
// src/bedrock/region.ts
export function resolveBedrockRegion(config?: { region?: string }): string {
  const fromConfig = config?.region?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv =
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim();
  if (fromEnv) return fromEnv;
  return "us-east-1";
}
```

In `src/types.ts` `LlmConfig`, add:

```typescript
  /** AWS region for amazon-bedrock catalog + invoke. Ignored by other providers. */
  region?: string;
```

In `src/config.ts` validation (near other `llm` checks), add:

```typescript
  if (out.llm.region !== undefined) {
    if (typeof out.llm.region !== "string" || !out.llm.region.trim()) {
      configWarn("Invalid llm.region, ignoring");
      delete out.llm.region;
    } else {
      out.llm.region = out.llm.region.trim();
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/bedrock-region.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bedrock/region.ts src/types.ts src/config.ts tests/bedrock-region.test.ts
git commit -m "$(cat <<'EOF'
feat(bedrock): add llm.region resolver

EOF
)"
```

---

### Task 2: Bedrock credentials + availability

**Files:**
- Create: `src/bedrock/credentials.ts`
- Modify: `src/llm.ts` (`isProviderAvailable`, `getMissingKeyMessage`)
- Test: `tests/bedrock-credentials.test.ts`
- Modify: `tests/llm.test.ts` (widen existing Bedrock tests)

**Interfaces:**
- Consumes: `getApiKey` / `hasApiKey` from `src/credentials.ts`
- Produces:
  - `hasAmbientAwsCredentials(): boolean`
  - `resolveBedrockBearerToken(): string | undefined`
  - `isBedrockAvailable(): boolean`
  - `getBedrockMissingCredentialsMessage(): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/bedrock-credentials.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasAmbientAwsCredentials,
  resolveBedrockBearerToken,
  isBedrockAvailable,
  getBedrockMissingCredentialsMessage,
} from "../src/bedrock/credentials.js";
import { setApiKey, resetCredentialStoreForTests } from "../src/credentials.js";

const AWS_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "PRAANA_HOME",
] as const;

describe("bedrock credentials", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-bedrock-cred-"));
    for (const k of AWS_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PRAANA_HOME = home;
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("detects ambient sources and bearer/store", () => {
    expect(hasAmbientAwsCredentials()).toBe(false);
    expect(isBedrockAvailable()).toBe(false);

    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    expect(resolveBedrockBearerToken()).toBe("tok");
    expect(isBedrockAvailable()).toBe(true);
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;

    setApiKey("amazon-bedrock", "stored-tok");
    expect(resolveBedrockBearerToken()).toBe("stored-tok");
    expect(isBedrockAvailable()).toBe(true);

    process.env.AWS_PROFILE = "dev";
    expect(hasAmbientAwsCredentials()).toBe(true);
  });

  it("missing message mentions API key and AWS credentials", () => {
    const msg = getBedrockMissingCredentialsMessage();
    expect(msg).toMatch(/Bedrock API key/i);
    expect(msg).toMatch(/AWS_/);
  });
});
```

Also update `tests/llm.test.ts` Bedrock cases to clear the new env vars and assert store bearer makes `isProviderAvailable("amazon-bedrock")` true.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test tests/bedrock-credentials.test.ts`

- [ ] **Step 3: Implement**

```typescript
// src/bedrock/credentials.ts
import { getApiKey, hasApiKey } from "../credentials.js";

const AMBIENT_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

export function hasAmbientAwsCredentials(): boolean {
  return AMBIENT_KEYS.some((k) => !!process.env[k]?.trim());
}

/** Store key wins over AWS_BEARER_TOKEN_BEDROCK. */
export function resolveBedrockBearerToken(): string | undefined {
  const stored = getApiKey("amazon-bedrock")?.trim();
  if (stored) return stored;
  const env = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  return env || undefined;
}

export function isBedrockAvailable(): boolean {
  return hasApiKey("amazon-bedrock") || hasAmbientAwsCredentials();
}

export function getBedrockMissingCredentialsMessage(): string {
  return (
    'Amazon Bedrock is not configured. Set AWS credentials (AWS_ACCESS_KEY_ID / ' +
    "AWS_PROFILE / web identity / container role) or AWS_BEARER_TOKEN_BEDROCK, " +
    "or paste a Bedrock API key via /setup or login."
  );
}
```

In `src/llm.ts` `isProviderAvailable`:

```typescript
  if (provider === "amazon-bedrock") {
    return isBedrockAvailable();
  }
```

In `getMissingKeyMessage`, before generic fallbacks:

```typescript
  if (provider === "amazon-bedrock") {
    return getBedrockMissingCredentialsMessage();
  }
```

Import from `./bedrock/credentials.js`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test tests/bedrock-credentials.test.ts tests/llm.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/bedrock/credentials.ts src/llm.ts tests/bedrock-credentials.test.ts tests/llm.test.ts
git commit -m "$(cat <<'EOF'
feat(bedrock): widen AWS credential detection

EOF
)"
```

---

### Task 3: Catalog filter + inference-profile preference (pure)

**Files:**
- Create: `src/bedrock/catalog.ts` (pure helpers first; fetch in Task 4)
- Test: `tests/bedrock-catalog.test.ts`

**Interfaces:**
- Produces:
  - `foundationModelIdFromArn(arn: string): string | null`
  - `isChatCapableFoundationModel(m: FoundationModelLike): boolean`
  - `buildBedrockCatalogIds(input: { foundationModels: FoundationModelLike[]; profiles: InferenceProfileLike[] }): string[]`

Types (export from `catalog.ts`):

```typescript
export interface FoundationModelLike {
  modelId: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
}

export interface InferenceProfileLike {
  inferenceProfileId: string;
  status?: string;
  type?: string;
  models?: Array<{ modelArn?: string }>;
}
```

- [ ] **Step 1: Write failing tests**

```typescript
// tests/bedrock-catalog.test.ts
import { describe, it, expect } from "bun:test";
import {
  foundationModelIdFromArn,
  isChatCapableFoundationModel,
  buildBedrockCatalogIds,
} from "../src/bedrock/catalog.js";

describe("bedrock catalog pure logic", () => {
  it("extracts FM id from ARN", () => {
    expect(
      foundationModelIdFromArn(
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
      ),
    ).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
    expect(foundationModelIdFromArn("not-an-arn")).toBeNull();
  });

  it("requires TEXT in/out and excludes non-streaming when false", () => {
    expect(
      isChatCapableFoundationModel({
        modelId: "anthropic.claude-x",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
      }),
    ).toBe(true);
    expect(
      isChatCapableFoundationModel({
        modelId: "amazon.titan-embed",
        inputModalities: ["TEXT"],
        outputModalities: ["EMBEDDING"],
      }),
    ).toBe(false);
    expect(
      isChatCapableFoundationModel({
        modelId: "anthropic.claude-x",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: false,
      }),
    ).toBe(false);
  });

  it("prefers profiles and suppresses covered base ids", () => {
    const ids = buildBedrockCatalogIds({
      foundationModels: [
        {
          modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
        },
        {
          modelId: "amazon.nova-micro-v1:0",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
        },
      ],
      profiles: [
        {
          inferenceProfileId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
            },
          ],
        },
        {
          inferenceProfileId: "us.amazon.titan-embed-text-v2:0",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0",
            },
          ],
        },
      ],
    });
    expect(ids).toContain("us.anthropic.claude-sonnet-4-20250514-v1:0");
    expect(ids).not.toContain("anthropic.claude-sonnet-4-20250514-v1:0");
    expect(ids).toContain("amazon.nova-micro-v1:0");
    expect(ids).not.toContain("us.amazon.titan-embed-text-v2:0"); // FM not chat-capable
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test tests/bedrock-catalog.test.ts`

- [ ] **Step 3: Implement pure helpers in `src/bedrock/catalog.ts`**

```typescript
export function foundationModelIdFromArn(arn: string): string | null {
  const marker = "foundation-model/";
  const idx = arn.indexOf(marker);
  if (idx < 0) return null;
  const id = arn.slice(idx + marker.length).trim();
  return id || null;
}

export function isChatCapableFoundationModel(m: FoundationModelLike): boolean {
  const inputs = m.inputModalities ?? [];
  const outputs = m.outputModalities ?? [];
  if (!inputs.includes("TEXT") || !outputs.includes("TEXT")) return false;
  if (m.responseStreamingSupported === false) return false;
  return true;
}

export function buildBedrockCatalogIds(input: {
  foundationModels: FoundationModelLike[];
  profiles: InferenceProfileLike[];
}): string[] {
  const chatCapable = new Set(
    input.foundationModels
      .filter(isChatCapableFoundationModel)
      .map((m) => m.modelId),
  );

  const covered = new Set<string>();
  const profileIds: string[] = [];

  for (const profile of input.profiles) {
    if (profile.status && profile.status !== "ACTIVE") continue;
    const linked = (profile.models ?? [])
      .map((m) => (m.modelArn ? foundationModelIdFromArn(m.modelArn) : null))
      .filter((id): id is string => !!id);
    const qualifies = linked.some((id) => chatCapable.has(id));
    if (!qualifies) continue;
    profileIds.push(profile.inferenceProfileId);
    for (const id of linked) {
      if (chatCapable.has(id)) covered.add(id);
    }
  }

  const baseIds = [...chatCapable].filter((id) => !covered.has(id));
  return [...new Set([...profileIds, ...baseIds])].sort((a, b) =>
    a.localeCompare(b),
  );
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test tests/bedrock-catalog.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/bedrock/catalog.ts tests/bedrock-catalog.test.ts
git commit -m "$(cat <<'EOF'
feat(bedrock): add chat filter and inference-profile preference

EOF
)"
```

---

### Task 4: Live catalog fetch + provider-catalog wiring

**Files:**
- Modify: `src/bedrock/catalog.ts` (add `fetchBedrockLiveCatalog`)
- Modify: `src/provider-registry.ts` — add `"amazon-bedrock"` to `LIVE_CATALOG_PROVIDER_IDS`; remove from `SETUP_UNSUPPORTED_PROVIDERS`
- Modify: `src/provider-catalog.ts` — Bedrock branch in `fetchProviderCatalogFresh`
- Dependency: `bun add @aws-sdk/client-bedrock`
- Test: `tests/provider-catalog-bedrock.test.ts`
- Use existing `resetProviderCatalogCacheForTests()` from `src/provider-catalog.ts`

**Interfaces:**
- Consumes: `resolveBedrockRegion`, `resolveBedrockBearerToken`, `buildBedrockCatalogIds`
- Produces: `fetchBedrockLiveCatalog(opts: { region: string; bearerToken?: string; listFoundationModels?: …; listInferenceProfiles?: … }): Promise<Record<string, number | null>>`
- Inject list functions for tests (do not hit live AWS in CI).

Context windows: for each catalog id, look up pi-ai `getModels("amazon-bedrock")`; if id matches, use `contextWindow`; else try matching foundation model id by stripping leading `us.` / `eu.` / `apac.` / `global.` once; else `null`.

- [ ] **Step 1: Write failing integration test with injected list fns**

```typescript
// tests/provider-catalog-bedrock.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fetchBedrockLiveCatalog } from "../src/bedrock/catalog.js";
import {
  providerSupportsLiveCatalog,
  resetProviderCatalogCacheForTests,
} from "../src/provider-catalog.js";

describe("bedrock live catalog", () => {
  beforeEach(() => resetProviderCatalogCacheForTests());
  afterEach(() => resetProviderCatalogCacheForTests());

  it("marks amazon-bedrock as live-catalog capable", () => {
    expect(providerSupportsLiveCatalog("amazon-bedrock")).toBe(true);
  });

  it("builds id→window map from mocked AWS lists", async () => {
    const models = await fetchBedrockLiveCatalog({
      region: "us-east-1",
      listFoundationModels: async () => [
        {
          modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
        },
      ],
      listInferenceProfiles: async () => [
        {
          inferenceProfileId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
            },
          ],
        },
      ],
    });
    expect(models["us.anthropic.claude-sonnet-4-20250514-v1:0"]).not.toBeUndefined();
    expect(models["anthropic.claude-sonnet-4-20250514-v1:0"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement fetch + wiring**

```typescript
// fetchBedrockLiveCatalog — default impl uses BedrockClient
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";

export async function fetchBedrockLiveCatalog(opts: {
  region: string;
  bearerToken?: string;
  listFoundationModels?: () => Promise<FoundationModelLike[]>;
  listInferenceProfiles?: () => Promise<InferenceProfileLike[]>;
}): Promise<Record<string, number | null>> {
  const foundationModels =
    (await opts.listFoundationModels?.()) ??
    (await defaultListFoundationModels(opts));
  const profiles =
    (await opts.listInferenceProfiles?.()) ??
    (await defaultListInferenceProfiles(opts));

  const ids = buildBedrockCatalogIds({ foundationModels, profiles });
  const windows = resolveContextWindows(ids);
  const out: Record<string, number | null> = {};
  for (const id of ids) out[id] = windows.get(id) ?? null;
  return out;
}
```

Default list helpers: construct `BedrockClient({ region })`. If `bearerToken` is set, configure the client per AWS SDK bearer-token / middleware patterns used by pi-ai (prefer setting `process.env.AWS_BEARER_TOKEN_BEDROCK` only inside the call via a local override if the SDK reads it — **do not** leave a mutated env after the call; restore previous value in `finally`). Paginate with `nextToken` until exhausted.

In `fetchProviderCatalogFresh` (`src/provider-catalog.ts`), early branch:

```typescript
  if (provider === "amazon-bedrock") {
    const { resolveBedrockRegion } = await import("./bedrock/region.js");
    const { resolveBedrockBearerToken } = await import("./bedrock/credentials.js");
    const { fetchBedrockLiveCatalog } = await import("./bedrock/catalog.js");
    // or static imports at top
    const models = await fetchBedrockLiveCatalog({
      region: resolveBedrockRegion(/* pass loaded config region if available */),
      bearerToken: resolveBedrockBearerToken(),
      // AbortSignal: race/timeout already wraps this function — ensure client respects controller.signal if feasible
    });
    // persist + return same as HTTP path
  }
```

**Region from config at catalog time:** `provider-catalog.ts` does not currently receive `PraanaConfig`. Prefer reading region via `resolveBedrockRegion()` (env + default) for catalog fetches, and ensure `buildModel` passes `config.region` into `__piOptions`. Optional improvement: accept optional `region` override parameter on `listProviderCatalogModels` — only if existing call sites make it easy; otherwise document that catalog uses env/default and invoke uses full config precedence (config still wins for invoke). **Required for success criteria:** when `llm.region` is set, invoke uses it. For catalog, thread region by exporting a module-level optional override set at session start, **or** pass region into `listProviderCatalogModels(provider, { region })` and update call sites that know config. Prefer the explicit opts param:

```typescript
export async function listProviderCatalogModels(
  provider: string,
  opts?: { region?: string },
): Promise<ProviderCatalogModelEntry[]>
```

When `provider === "amazon-bedrock"`, `resolveBedrockRegion({ region: opts?.region })`.

Update `fetchProviderModels` in setup to pass nothing (env/default OK). Update any session `/model` path that has config to pass `session.config.llm.region` when listing.

- [ ] **Step 4: Registry edits**

```typescript
// LIVE_CATALOG_PROVIDER_IDS — append:
  "amazon-bedrock",

// SETUP_UNSUPPORTED_PROVIDERS — remove amazon-bedrock:
export const SETUP_UNSUPPORTED_PROVIDERS = new Set(["ollama"]);
```

Update `tests/provider-registry.test.ts` accordingly (Bedrock no longer in unsupported set; still `envKey: null`).

- [ ] **Step 5: Run tests**

Run: `bun test tests/bedrock-catalog.test.ts tests/provider-catalog-bedrock.test.ts tests/provider-registry.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/bedrock/catalog.ts src/provider-catalog.ts src/provider-registry.ts tests/provider-catalog-bedrock.test.ts tests/provider-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(bedrock): live chat catalog via ListFoundationModels

EOF
)"
```

---

### Task 5: `buildModel` `__piOptions` for region + bearerToken

**Files:**
- Modify: `src/llm.ts` — both `buildFromPiAiCatalog` and `buildModel`
- Test: `tests/llm-bedrock-options.test.ts` (or extend `tests/llm.test.ts`)

**Interfaces:**
- Consumes: `resolveBedrockRegion`, `resolveBedrockBearerToken`
- Produces: `RuntimeModel.__piOptions = { region, bearerToken? }` for Bedrock (no `apiKey`)

- [ ] **Step 1: Write failing test**

```typescript
// tests/llm-bedrock-options.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProvider } from "../src/llm.js";
import { setApiKey, resetCredentialStoreForTests } from "../src/credentials.js";

describe("bedrock __piOptions", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-bedrock-opts-"));
    for (const k of ["PRAANA_HOME", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PRAANA_HOME = home;
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sets region and bearerToken, not apiKey", () => {
    setApiKey("amazon-bedrock", "stored-tok");
    const build = createProvider({
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      region: "eu-west-1",
    });
    const model = build("us.anthropic.claude-sonnet-4-20250514-v1:0") as {
      __piOptions?: Record<string, unknown>;
    };
    expect(model.__piOptions?.region).toBe("eu-west-1");
    expect(model.__piOptions?.bearerToken).toBe("stored-tok");
    expect(model.__piOptions?.apiKey).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement helper and wire both build paths**

```typescript
function bedrockPiOptions(config: PraanaConfig["llm"]): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    region: resolveBedrockRegion(config),
  };
  const bearer = resolveBedrockBearerToken();
  if (bearer) opts.bearerToken = bearer;
  return opts;
}

// In buildFromPiAiCatalog and buildModel, when config.provider === "amazon-bedrock":
  model.__piOptions = bedrockPiOptions(config);
// else existing apiKey/headers assignment
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test tests/llm.test.ts tests/llm-bedrock-options.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts tests/llm-bedrock-options.test.ts
git commit -m "$(cat <<'EOF'
feat(bedrock): pass region and bearerToken via __piOptions

EOF
)"
```

---

### Task 6: Setup + login UX (ambient or prompt for Bedrock API key)

**Files:**
- Modify: `src/setup/logic.ts` — add helper
- Modify: `src/ui/tui/setup-wizard.ts`
- Modify: `src/ui/tui/login-wizard.ts`
- Modify: `src/setup/setup-readline.ts`
- Test: `tests/setup-bedrock.test.ts` (logic helper); manual note for TUI if hard to unit-test

**Interfaces:**
- Produces:

```typescript
/** True when Bedrock was selected but needs a pasted API key. */
export function bedrockNeedsApiKeyPrompt(): boolean {
  return !isBedrockAvailable();
}
```

Copy for key prompt: `"Paste your Bedrock API key (bearer token)."` + muted hint about AWS IAM/profile alternative.

- [ ] **Step 1: Write failing logic test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bedrockNeedsApiKeyPrompt } from "../src/setup/logic.js";
// clear AWS env + store → true; set AWS_PROFILE → false
```

- [ ] **Step 2: Implement helper in `setup/logic.ts`**

- [ ] **Step 3: Setup wizard**

In `showProviderStep` `onSelect` for catalog providers:

```typescript
          state.provider = item.value;
          if (item.value === "amazon-bedrock") {
            if (bedrockNeedsApiKeyPrompt()) {
              showBedrockKeyEntryStep(); // or reuse showKeyInputField with Bedrock copy + require non-empty
            } else {
              showModelFetchStep();
            }
            return;
          }
          showKeyEntryStep();
```

Bedrock key entry: require non-empty trim; `saveProviderKey("amazon-bedrock", trimmed)`; then `showModelFetchStep()`.

- [ ] **Step 4: Login wizard**

Replace blind keyless finish:

```typescript
        if (providerRequiresApiKey(hint)) {
          this.step = hasApiKey(hint) ? "has-key" : "key";
        } else if (hint === "amazon-bedrock") {
          if (isBedrockAvailable()) {
            this.finishKeyless();
            return;
          }
          this.step = "key"; // show Bedrock API key entry
        } else {
          this.finishKeyless();
          return;
        }
```

Same branch in picker `onSelect`. Update key-entry body text when `this.provider === "amazon-bedrock"` to say Bedrock API key. Empty submit for Bedrock should error (required), unlike ollama.

- [ ] **Step 5: Readline setup**

When `providerId === "amazon-bedrock"`:

- If `isBedrockAvailable()` → skip key prompts.
- Else → prompt until non-empty key saved.

- [ ] **Step 6: Update registry tests already done; run**

Run: `bun test tests/setup-bedrock.test.ts tests/provider-registry.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/setup/logic.ts src/ui/tui/setup-wizard.ts src/ui/tui/login-wizard.ts src/setup/setup-readline.ts tests/setup-bedrock.test.ts
git commit -m "$(cat <<'EOF'
feat(bedrock): setup and login API key prompt

EOF
)"
```

---

### Task 7: Docs + example config

**Files:**
- Modify: `AGENTS.md` (provider keys / Bedrock notes)
- Modify: `docs/ARCHITECTURE.md` (live catalog line for Bedrock control plane; `llm.region`)
- Modify: `praana.config.example.toml` (commented `region`, auth notes for Bedrock API key)
- Mirror: `~/win_documents/Github/praana-internal/technical/` (short note or copy of user-facing bullets)

- [ ] **Step 1: Edit docs**

`praana.config.example.toml`:

```toml
#   amazon-bedrock — AWS Bedrock (AWS credentials and/or Bedrock API key)
# region = "us-east-1"  # amazon-bedrock only; else AWS_REGION / AWS_DEFAULT_REGION / us-east-1
```

`docs/ARCHITECTURE.md` live catalog sentence — change to note Bedrock uses `ListFoundationModels` / `ListInferenceProfiles` (cached 6h), not OpenAI `/models`.

`AGENTS.md` — mention `AWS_*` / Bedrock API key and `llm.region`.

- [ ] **Step 2: Sync internal docs copy**

```bash
cp docs/superpowers/specs/2026-07-23-amazon-bedrock-support-design.md \
  ~/win_documents/Github/praana-internal/technical/
# Plus a short STATE/ROADMAP note if that repo tracks shipped work
```

- [ ] **Step 3: Full verify**

Run: `bun typecheck && bun test`

Expected: clean

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/ARCHITECTURE.md praana.config.example.toml
git commit -m "$(cat <<'EOF'
docs: document Amazon Bedrock setup, region, and live catalog

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| `llm.region` + env precedence | 1 |
| Invoke uses same region via `__piOptions` | 5 (+ catalog opts in 4) |
| Widened ambient AWS detection | 2 |
| Bearer in credential store + resolve order | 2, 5, 6 |
| Live ListFoundationModels + ListInferenceProfiles | 4 |
| TEXT chat filter + hard-exclude non-streaming | 3 |
| Prefer profiles via `foundation-model/` ARN; qualify via chat FM set | 3 |
| Soft-fail catalog to pi-ai static | existing `listModelsForProvider` (verify in Task 4) |
| Remove from SETUP_UNSUPPORTED | 4 |
| Setup/login ambient-or-prompt-bearer | 6 |
| Docs | 7 |
| `@aws-sdk/client-bedrock` | 4 |
| Never log secrets | 2–6 (no logging of tokens) |

## Placeholder / consistency self-check

- No TBD remaining for match rules or streaming semantics.
- `bearerToken` naming consistent across tasks.
- `buildBedrockCatalogIds` is the single prefer/filter entry used by fetch.
- Both `buildFromPiAiCatalog` and `buildModel` covered in Task 5.
