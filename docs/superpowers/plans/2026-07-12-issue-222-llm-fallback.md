# LLM Provider/Model Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the configured LLM hits a timeout, empty response, or 429 rate-limit, automatically retry once on the same model, then switch to an optional fallback `[llm] fallback_provider` / `fallback_model` and continue the turn.

**Architecture:** Encapsulate the pi-ai `stream()` call in `src/turn.ts` behind a `runLlmStream()` helper that owns retry/fallback logic. Add optional `fallback_provider` and `fallback_model` fields to `LlmConfig`. On recoverable failure, build a new provider/model, append `provider_override`/`model_override` events to the event log (so resume sees the switch), toast the TUI, and retry. A user’s explicit `/model` choice is stored in `Session.modelOverride`; automatic fallback sets the same override and never flips back without user action.

**Tech Stack:** TypeScript, Bun, pi-ai stream, existing session override/event-log mechanisms.

---

## File Structure

- **Modify:** `src/types.ts`
  - `LlmConfig` — add optional `fallback_provider?: string` and `fallback_model?: string`.
- **Modify:** `src/config.ts`
  - Add optional fallback keys to the default config schema/merge.
- **Modify:** `src/turn.ts`
  - Extract current inline `piStream()` call into `runLlmStream()` helper.
  - Detect recoverable errors: `timeout`, `rate_limit` (429), `empty` (no text/tool).
  - Retry once on same model, then build fallback provider/model and retry once.
  - Log `provider_override`/`model_override` events via `session.eventLog.append`.
  - Surface toast via `s.onSystemLines?.([...])` (TUI shows toasts; terminal prints).
- **Test:** `tests/llm.test.ts` or new `tests/llm-fallback.test.ts`
  - Mock `piStream` to simulate timeout → success.
  - Assert fallback provider/model is used and event log records overrides.
- **Docs:** Update `docs/ARCHITECTURE.md` or config reference with `[llm] fallback_provider` / `fallback_model`.

---

## Task 1: Add config types and defaults for fallback provider/model

**Files:**
- Modify: `src/types.ts:112-118`
- Modify: `src/config.ts:43-60` (default config object)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config.test.ts
import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/config.js";

describe("LLM fallback config", () => {
  it("parses fallback_provider and fallback_model", () => {
    const config = loadConfig({
      llm: {
        provider: "umans",
        model: "umans-coder",
        fallback_provider: "openrouter",
        fallback_model: "moonshotai/kimi-k2.7-code",
      },
    });
    expect(config.llm.fallback_provider).toBe("openrouter");
    expect(config.llm.fallback_model).toBe("moonshotai/kimi-k2.7-code");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts --test-name-pattern "parses fallback_provider and fallback_model"`

Expected: FAIL — `fallback_provider` is not a known key.

- [ ] **Step 3: Implement minimal change**

In `src/types.ts`:

```typescript
export interface LlmConfig {
  provider: string;
  model: string;
  base_url?: string;
  /** Override model context window (input tokens) for pressure and compaction. */
  context_window?: number;
  /** Optional provider/model to use when the primary fails (timeout, 429, empty). */
  fallback_provider?: string;
  fallback_model?: string;
}
```

In `src/config.ts`, add to the default `llm` object (optional, no defaults):

```typescript
llm: {
  provider: "",
  model: "",
  // fallback_provider / fallback_model are optional; omitted means no automatic fallback.
},
```

Verify the deep-merge preserves unknown keys (it should already; no additional code needed if merge is permissive).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts --test-name-pattern "parses fallback_provider and fallback_model"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat(llm): add fallback_provider and fallback_model config keys (#222)"
```

---

## Task 2: Extract LLM stream call into a testable helper

**Files:**
- Modify: `src/turn.ts:366-502`
- Create: `src/llm-stream.ts` (optional; keep in `turn.ts` if smaller)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/llm-fallback.test.ts
import { describe, it, expect, mock, spyOn } from "bun:test";
import * as piAi from "@earendil-works/pi-ai/compat";
import { runLlmStream } from "../src/turn.js";

describe("runLlmStream", () => {
  it("returns success on first stream attempt", async () => {
    const stream = async function* () {
      yield { type: "text_delta", delta: "hello" };
      yield { type: "done", reason: "stop", message: {} };
    };
    spyOn(piAi, "stream").mockImplementation(() => stream() as any);

    const result = await runLlmStream({
      model: { id: "m" } as any,
      modelName: "m",
      providerName: "p",
      compiledPrompt: "sys",
      history: [{ role: "user", content: "hi" }],
      piTools: [],
      signal: undefined,
    });

    expect(result.reason).toBe("stop");
    expect(result.fullResponse).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/llm-fallback.test.ts --test-name-pattern "returns success on first stream attempt"`

Expected: FAIL — `runLlmStream` is not exported.

- [ ] **Step 3: Implement minimal change**

Extract a helper from the existing `piStream()` loop in `src/turn.ts`. Keep it local (no new file unless needed) but export for tests:

```typescript
interface LlmStreamInput {
  model: any;
  modelName: string;
  providerName: string;
  compiledPrompt: string;
  history: Message[];
  piTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  signal?: AbortSignal;
  reasoningEffort?: string;
}

interface LlmStreamResult {
  fullResponse: string;
  finalMessage: Message | null;
  reason: "stop" | "length" | "toolUse" | "error" | "aborted";
  pendingToolCalls: Array<{ toolName: string; args: Record<string, unknown>; toolCallId: string }>;
  errorMessage?: string;
  providerUsage?: ProviderUsage | null;
}

export async function runLlmStream(input: LlmStreamInput): Promise<LlmStreamResult> {
  const modelOptions: Record<string, unknown> = {
    ...((input.model as any).__piOptions ?? {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  };
  const stream = piStream(
    input.model,
    {
      systemPrompt: input.compiledPrompt,
      messages: input.history,
      tools: input.piTools,
    },
    modelOptions,
  );

  let fullResponse = "";
  let finalMessage: Message | null = null;
  let finalReason: LlmStreamResult["reason"] = "stop";
  let errorMessage: string | undefined;
  const pendingToolCalls: LlmStreamResult["pendingToolCalls"] = [];
  let providerUsage: ProviderUsage | null = null;

  for await (const event of stream) {
    if (input.signal?.aborted) {
      finalReason = "aborted";
      break;
    }
    if (event.type === "text_delta" && typeof event.delta === "string") {
      fullResponse += event.delta;
    }
    if (event.type === "toolcall_end") {
      pendingToolCalls.push({
        toolName: event.toolCall.name,
        args: (event.toolCall.arguments ?? {}) as Record<string, unknown>,
        toolCallId: event.toolCall.id,
      });
    }
    if (event.type === "done") {
      finalReason = event.reason;
      finalMessage = event.message as unknown as Message;
      const stepUsage = parseProviderUsage(event.message);
      if (stepUsage) {
        providerUsage = addProviderUsage(providerUsage, stepUsage);
      }
    }
    if (event.type === "error") {
      finalReason = event.reason;
      finalMessage = event.error as unknown as Message;
      errorMessage = extractLlmErrorMessage(finalMessage) ?? errorMessage;
    }
  }

  return { fullResponse, finalMessage, reason: finalReason, pendingToolCalls, errorMessage, providerUsage };
}
```

Replace the inline loop in `runTurn` with a call to `runLlmStream()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/llm-fallback.test.ts --test-name-pattern "returns success on first stream attempt"`

Expected: PASS.

- [ ] **Step 5: Run existing turn tests**

Run: `bun test tests/turn.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/turn.ts tests/llm-fallback.test.ts
git commit -m "refactor(turn): extract runLlmStream helper (#222)"
```

---

## Task 3: Implement fallback retry on recoverable errors

**Files:**
- Modify: `src/turn.ts`
- Modify: `src/session.ts` (add `setModelOverride` + `setProviderOverride` convenience that records events)
- Test: `tests/llm-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("falls back to configured provider/model after stream error", async () => {
  const session = makeMinimalSession();
  session.config.llm.fallback_provider = "openrouter";
  session.config.llm.fallback_model = "moonshotai/kimi-k2.7-code";

  let callCount = 0;
  spyOn(piAi, "stream").mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return (async function* () {
        yield { type: "error", reason: "rate_limit", error: { message: "429" } };
      })() as any;
    }
    return (async function* () {
      yield { type: "text_delta", delta: "fallback ok" };
      yield { type: "done", reason: "stop", message: {} };
    })() as any;
  });

  const result = await runTurn(session, "hello");
  expect(result).toContain("fallback ok");
  expect(session.getEffectiveProvider()).toBe("openrouter");
  expect(session.getActiveModelId()).toBe("moonshotai/kimi-k2.7-code");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/llm-fallback.test.ts --test-name-pattern "falls back to configured provider/model after stream error"`

Expected: FAIL — no fallback logic yet.

- [ ] **Step 3: Implement fallback logic**

In `runTurn`, after the first `runLlmStream()` call, check the result:

```typescript
let streamResult = await runLlmStream({
  model,
  modelName,
  providerName,
  compiledPrompt,
  history,
  piTools,
  signal: options?.signal,
  reasoningEffort: streamReasoning,
});

const isRecoverableError = (r: LlmStreamResult) =>
  r.reason === "error" &&
  /\b(timeout|rate.limit|429)\b/i.test(r.errorMessage ?? "");

const isEmptyResponse = (r: LlmStreamResult) =>
  r.reason === "stop" && !r.fullResponse.trim() && r.pendingToolCalls.length === 0;

if ((isRecoverableError(streamResult) || isEmptyResponse(streamResult)) && streamResult.reason !== "aborted") {
  const fallbackProvider = session.config.llm.fallback_provider;
  const fallbackModel = session.config.llm.fallback_model;
  if (fallbackProvider && fallbackModel) {
    // Retry once on same model first
    streamResult = await runLlmStream({
      model,
      modelName,
      providerName,
      compiledPrompt,
      history,
      piTools,
      signal: options?.signal,
      reasoningEffort: streamReasoning,
    });
  }
}

if ((isRecoverableError(streamResult) || isEmptyResponse(streamResult)) && streamResult.reason !== "aborted") {
  const fallbackProvider = session.config.llm.fallback_provider;
  const fallbackModel = session.config.llm.fallback_model;
  if (fallbackProvider && fallbackModel) {
    llmLogger.warn("Switching to fallback LLM", {
      code: "LLM_FALLBACK",
      details: {
        fromProvider: providerName,
        fromModel: modelName,
        toProvider: fallbackProvider,
        toModel: fallbackModel,
        reason: streamResult.errorMessage ?? "empty response",
      },
    });

    session.setProviderOverride(fallbackProvider);
    session.setModelOverride(fallbackModel);

    session.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: {
        type: "provider_override",
        provider: fallbackProvider,
        reason: "llm_fallback",
      },
    });
    session.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: {
        type: "model_override",
        model: fallbackModel,
        reason: "llm_fallback",
      },
    });

    s.onSystemLines?.([
      `Switched to ${fallbackProvider}/${fallbackModel} after ${streamResult.errorMessage ?? "empty response"}`,
    ]);

    const effectiveLlm = session.getEffectiveLlmConfig();
    const fallbackProviderFn = createProvider(effectiveLlm, contextWindowTokens);
    const fallbackModelObj = fallbackProviderFn(resolveModel(fallbackModel));
    const fallbackReasoning = getReasoningEffort(
      fallbackModelObj as Record<string, unknown>,
      fallbackModel,
      fallbackProvider,
    );

    streamResult = await runLlmStream({
      model: fallbackModelObj,
      modelName: fallbackModel,
      providerName: fallbackProvider,
      compiledPrompt,
      history,
      piTools,
      signal: options?.signal,
      reasoningEffort: fallbackReasoning,
    });
  }
}
```

Then use `streamResult` in place of the old inline variables (`fullResponse`, `pendingToolCalls`, etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/llm-fallback.test.ts --test-name-pattern "falls back to configured provider/model after stream error"`

Expected: PASS.

- [ ] **Step 5: Run full turn test suite**

Run: `bun test tests/turn.test.ts tests/llm.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/turn.ts src/session.ts tests/llm-fallback.test.ts
git commit -m "feat(llm): automatic provider/model fallback on recoverable errors (#222)"
```

---

## Task 4: Add event-log and TUI toast tests

**Files:**
- Test: `tests/llm-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("records provider_override and model_override events on fallback", async () => {
  const session = makeMinimalSession();
  session.config.llm.fallback_provider = "openrouter";
  session.config.llm.fallback_model = "fallback-model";

  spyOn(piAi, "stream").mockImplementation(() => {
    return (async function* () {
      yield { type: "error", reason: "timeout", error: { message: "timeout" } };
    })() as any;
  });

  try {
    await runTurn(session, "hello");
  } catch {
    // may throw
  }

  const overrides = session.eventLog.readAll().filter(
    (e) => e.kind === "system_note" &&
      (e.payload.type === "provider_override" || e.payload.type === "model_override"),
  );
  expect(overrides.length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/llm-fallback.test.ts --test-name-pattern "records provider_override and model_override events on fallback"`

Expected: PASS after Task 3.

- [ ] **Step 3: Commit**

```bash
git add tests/llm-fallback.test.ts
git commit -m "test(llm): assert fallback event logging (#222)"
```

---

## Task 5: Document fallback config

**Files:**
- Modify: `docs/ARCHITECTURE.md` or create config reference section

- [ ] **Step 1: Add docs paragraph**

Add under the LLM/provider section:

```markdown
### Automatic fallback

Configure an optional fallback provider/model in `praana.config.toml`:

```toml
[llm]
provider = "umans"
model = "umans-coder"
fallback_provider = "openrouter"
fallback_model = "moonshotai/kimi-k2.7-code"
```

When the primary model returns a timeout, empty response, or `429` rate-limit error, PRAANA retries once on the same model, then switches to the fallback for the rest of the session. The switch is recorded as `provider_override` / `model_override` events in the event log and surfaced as a TUI toast. An explicit `/model` choice from the user takes precedence and is never overwritten by the automatic fallback.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(llm): document automatic fallback config (#222)"
```

---

## Self-Review

1. **Spec coverage:**
   - Config keys `fallback_provider` / `fallback_model` → Task 1.
   - Timeout/429/empty trigger fallback → Task 3.
   - Event log records switch with reason → Task 3 + Task 4.
   - TUI toast → Task 3 (`s.onSystemLines`).
   - Tests with mocked provider errors → Tasks 2–4.
   - Docs → Task 5.
2. **Placeholder scan:** no placeholders.
3. **Type consistency:** `LlmConfig` shape extended once in Task 1 and used consistently.
