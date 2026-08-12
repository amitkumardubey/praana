# Issue #11 Phase 2: LSP Diagnostics + Formatting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship opt-in LSP diagnostics and formatting for TypeScript/JavaScript, with session-scoped lifecycle and post-edit diagnostic diffs on `edit_file` / `batch_edit`.

**Architecture:** TypeScript stdio JSON-RPC client under `src/lsp/`, one `LspManager` per `Session`, agent tools in `src/tools/lsp.ts`, post-edit via hooks that run while the write-path lock is still held. Tree-sitter (`code_*`) unchanged.

**Tech Stack:** TypeScript (strict, NodeNext), Bun test, `node:child_process` stdio, LSP 3.18 JSON-RPC (`Content-Length` framing). No new production npm LSP SDK dependency.

**Spec:** [`docs/superpowers/specs/2026-08-12-lsp-phase2-design.md`](../specs/2026-08-12-lsp-phase2-design.md)

**Branch:** `feat/ad/issue-11-lsp-phase2` off `main` (create with user permission).

**Out of scope:** Phase 3 tools, Phase 4 restart/multi-root, CLI fallback formatters, auto-pipeline for `write_file` / `batch_write`, bundling language servers.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/lsp/types.ts` | Config-facing types, diagnostics, error codes, internal protocol types |
| **Create** `src/lsp/framing.ts` | Content-Length encode/decode helpers (pure) |
| **Create** `src/lsp/client.ts` | Stdio JSON-RPC client: initialize, requests, notifications, timeout, shutdown |
| **Create** `src/lsp/language.ts` | Extension → language id; server argv lookup |
| **Create** `src/lsp/manager.ts` | Session registry, doc sync, diagnostics cache, format, shutdown |
| **Create** `src/lsp/edits.ts` | Apply/validate LSP TextEdit arrays (descending order, overlap reject) |
| **Create** `src/lsp/index.ts` | Public exports |
| **Create** `src/tools/lsp.ts` | `lsp_diagnostics` / `lsp_format` tools |
| **Create** `src/hooks/handlers/lsp.ts` | Pre-snapshot + post-edit format/diag patch |
| **Create** `tests/fixtures/fake-lsp-server.ts` | Deterministic fake language server |
| **Create** `tests/lsp-framing.test.ts` | Framing unit tests |
| **Create** `tests/lsp-client.test.ts` | Client + fixture integration |
| **Create** `tests/lsp-manager.test.ts` | Lifecycle / reuse / shutdown |
| **Create** `tests/lsp-tools.test.ts` | Tool contracts, sandbox, plan-mode |
| **Create** `tests/lsp-config.test.ts` | Config defaults / validation |
| **Create** `tests/lsp-post-edit.test.ts` | Post-edit hook + lock ordering |
| **Modify** `src/types.ts`, `src/config.ts` | `LspConfig` + defaults + validation |
| **Modify** `src/session.ts` | Construct / shutdown manager |
| **Modify** `src/tools/index.ts` | Register LSP tools |
| **Modify** `src/hooks/index.ts` | Register LSP hooks in correct order |
| **Modify** `src/plan-mode.ts` | Block `lsp_format` |
| **Modify** `src/hooks/handlers/write-path.ts` | Treat `lsp_format` as write tool |
| **Modify** `src/domain/coding-domain.ts` | Artifact classification |
| **Modify** `src/ui/tui/tool-icons.ts` | Icons / labels |
| **Modify** `praana.config.example.toml`, `AGENTS.md`, architecture docs | Document `[lsp]` |

---

### Task 0: Branch + baseline

- [ ] **Step 1: Create branch (with user permission)**

```bash
git checkout main && git pull
git checkout -b feat/ad/issue-11-lsp-phase2
```

- [ ] **Step 2: Record baseline**

```bash
bun typecheck
bun test 2>&1 | tee /tmp/praana-baseline-test.txt
```

Expected: typecheck clean. Note any pre-existing failing setup-wizard tests (env/provider) so they are not blamed on this work.

- [ ] **Step 3: Commit design + plan docs if not already committed**

```bash
git add docs/superpowers/specs/2026-08-12-lsp-phase2-design.md \
        docs/superpowers/plans/2026-08-12-issue-11-lsp-phase2.md
git commit -m "$(cat <<'EOF'
docs: add issue #11 Phase 2 LSP design and plan

EOF
)"
```

---

### Task 1: Config contract

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `praana.config.example.toml`
- Test: `tests/lsp-config.test.ts`

- [ ] **Step 1: Write failing config tests**

```ts
import { describe, expect, it } from "bun:test";
import { loadConfig, deepMerge } from "../src/config.js";
import { DEFAULT-ish via loading empty } from "...";

describe("lsp config", () => {
  it("defaults to disabled with diagnostics on and format_on_edit off", () => {
    // load with no [lsp] → enabled false, diagnostics true, format_on_edit false,
    // timeout_ms 5000, max_file_lines 10000, servers {}
  });

  it("parses servers argv arrays", () => { /* ... */ });

  it("warns and falls back on invalid timeout_ms", () => { /* ... */ });
});
```

- [ ] **Step 2: Run tests — expect fail**

```bash
bun test tests/lsp-config.test.ts
```

- [ ] **Step 3: Add types**

In `src/types.ts`:

```ts
export interface LspConfig {
  enabled: boolean;
  diagnostics: boolean;
  format_on_edit: boolean;
  timeout_ms: number;
  max_file_lines: number;
  /** language id → argv (executable + args) */
  servers: Record<string, string[]>;
}
```

Add `lsp?: LspConfig` on `PraanaConfig` (optional with defaults applied in `loadConfig`, same pattern as `native`).

- [ ] **Step 4: Defaults + validation in `src/config.ts`**

```ts
lsp: {
  enabled: false,
  diagnostics: true,
  format_on_edit: false,
  timeout_ms: 5000,
  max_file_lines: 10_000,
  servers: {},
},
```

Validate after merge: coerce/warn invalid numbers and non-array server commands.

- [ ] **Step 5: Example TOML**

Comment block in `praana.config.example.toml` matching the design.

- [ ] **Step 6: Run tests — expect pass; commit**

```bash
bun test tests/lsp-config.test.ts
git add src/types.ts src/config.ts praana.config.example.toml tests/lsp-config.test.ts
git commit -m "feat(lsp): add [lsp] config defaults and validation"
```

---

### Task 2: Framing + fake server + client

**Files:**
- Create: `src/lsp/types.ts`, `src/lsp/framing.ts`, `src/lsp/client.ts`, `src/lsp/index.ts`
- Create: `tests/fixtures/fake-lsp-server.ts`
- Test: `tests/lsp-framing.test.ts`, `tests/lsp-client.test.ts`

- [ ] **Step 1: Framing helpers (TDD)**

```ts
// src/lsp/framing.ts
export function encodeMessage(body: object): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, json]);
}

export class FrameParser {
  // append(chunk): JsonRpcMessage[]
}
```

Tests: single message, split across chunks, multiple messages, bad Content-Length.

- [ ] **Step 2: Fake LSP server fixture**

`tests/fixtures/fake-lsp-server.ts` — Bun script reading stdin, writing stdout:

- Responds to `initialize` with `capabilities.textDocumentSync` + `documentFormattingProvider: true`
- On `initialized` / `didOpen` / `didChange`, optionally `publishDiagnostics` from env/JSON script
- `textDocument/formatting` returns scripted edits (env `FAKE_LSP_EDITS`)
- Supports `FAKE_LSP_DELAY_MS` for timeout tests
- Handles `shutdown` / `exit`

- [ ] **Step 3: `LspClient`**

```ts
export class LspClient {
  static async start(opts: {
    command: string[];
    cwd: string;
    rootUri: string;
    timeoutMs: number;
  }): Promise<LspClient>;

  request<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): Promise<void>;
  onNotification(method: string, handler: (params: unknown) => void): void;
  shutdown(): Promise<void>;
  get diagnosticsByUri(): Map<string, unknown[]>;
}
```

Spawn with `stdio: ["pipe","pipe","pipe"]`, `cwd` = workspace root. On start: `initialize` → wait result → `initialized`.

- [ ] **Step 4: Client tests via fixture**

```bash
bun test tests/lsp-framing.test.ts tests/lsp-client.test.ts
```

Cover: initialize, diagnostics notification, formatting response, timeout, missing executable → typed error, shutdown exits process.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(lsp): add JSON-RPC framing, client, and fake server fixture"
```

---

### Task 3: Language helpers + edit application + manager

**Files:**
- Create: `src/lsp/language.ts`, `src/lsp/edits.ts`, `src/lsp/manager.ts`
- Test: `tests/lsp-manager.test.ts` (+ unit tests for edits/language)

- [ ] **Step 1: Language resolution**

```ts
export function languageFromPath(path: string): string | null;
export function resolveServerArgv(
  language: string,
  servers: Record<string, string[]>,
): string[] | null;
// javascript → servers.javascript ?? servers.typescript
```

- [ ] **Step 2: Text edit applicator**

```ts
export function applyTextEdits(
  content: string,
  edits: Array<{ range: { start: Pos; end: Pos }; newText: string }>,
): { ok: true; content: string } | { ok: false; error: string };
```

Reject overlapping ranges; apply from end of document to start; positions are LSP 0-based.

- [ ] **Step 3: `LspManager`**

```ts
export class LspManager {
  constructor(private readonly opts: {
    config: LspConfig;
    cwd: string;
    workspaceRoot: string; // git root or cwd
  }) {}

  async diagnostics(absPath: string): Promise<Result<LspDiagnostic[]>>;
  async format(absPath: string): Promise<Result<{ changed: boolean; content?: string }>>;
  /** Snapshot then later diff — used by post-edit hook */
  async snapshotDiagnostics(absPath: string): Promise<LspDiagnostic[]>;
  async shutdown(): Promise<void>;
}
```

Behavior:
- If `!config.enabled` → `{ ok:false, code:"disabled" }`
- Lazy `Map<language, LspClient>`
- Open/sync full document text before format/diagnostics wait
- Cap by `max_file_lines`
- Convert diagnostics to 1-based agent shape
- `shutdown()` shuts all clients

- [ ] **Step 4: Manager tests with fake server**

Reuse across two diagnostics calls (single spawn), shutdown terminates child, oversized file soft-skips, disabled config never spawns.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(lsp): add manager, language map, and text-edit application"
```

---

### Task 4: Agent tools + registration

**Files:**
- Create: `src/tools/lsp.ts`
- Modify: `src/tools/index.ts`, `src/plan-mode.ts`, `src/hooks/handlers/write-path.ts`
- Modify: `src/domain/coding-domain.ts`, `src/ui/tui/tool-icons.ts`
- Test: `tests/lsp-tools.test.ts`, update `tests/tools.test.ts`, `tests/plan-mode.test.ts`

- [ ] **Step 1: Tools**

Mirror sandbox / path resolution patterns from `src/tools/code-intel.ts`. Inject `getLsp: () => LspManager | null`.

- `lsp_diagnostics` — read-only
- `lsp_format` — on success write file if changed; call `clearReadPath` / invalidate; return `{ ok, changed }`

- [ ] **Step 2: Register in `createAllTools`**

Pass manager from session via `ToolRegistryContext.lspManager`.

Add descriptions to `SHARED_TOOL_DESCRIPTIONS`.

- [ ] **Step 3: Plan mode + write-path**

```ts
// plan-mode.ts
PLAN_MODE_BLOCKED_TOOLS.add("lsp_format"); // or include in the Set literal

// write-path.ts WRITE_TOOLS
"lsp_format"
```

For `lsp_format`, `relPathsFromArgs` returns `[args.path]`.

- [ ] **Step 4: Classification + icons**

Treat `lsp_diagnostics` / `lsp_format` like search/edit appropriately in coding-domain and tool-icons.

- [ ] **Step 5: Tests + commit**

```bash
bun test tests/lsp-tools.test.ts tests/tools.test.ts tests/plan-mode.test.ts
git commit -m "feat(lsp): add lsp_diagnostics and lsp_format tools"
```

---

### Task 5: Session lifecycle + post-edit hooks

**Files:**
- Create: `src/hooks/handlers/lsp.ts`
- Modify: `src/hooks/index.ts`, `src/session.ts`, `src/turn.ts` (only if needed for context)
- Test: `tests/lsp-post-edit.test.ts`

- [ ] **Step 1: Construct manager in Session**

On create/resume after config load:

```ts
session.lspManager = new LspManager({
  config: cfg.lsp ?? defaults,
  cwd,
  workspaceRoot: findGitRoot(cwd) ?? cwd,
});
```

In `end()` / after `runSessionEnd`, `await session.lspManager?.shutdown()`.

Pass `lspManager` into `createAllTools` from `turn.ts`.

- [ ] **Step 2: Hook handlers**

```ts
// Pre: for edit_file / batch_edit when diagnostics enabled —
// snapshot diagnostics per path into WeakMap/session temp keyed by toolCall… 
// Prefer attaching snapshot on a per-invocation Map keyed by absPath held on the handler closure for the duration of the call.
```

Because pre and post share the same handler module instance, keep:

```ts
const pendingSnapshots = new Map<string, Map<string, LspDiagnostic[]>>();
// key = stable invocation key: `${toolName}:${JSON.stringify(paths)}` is racy under concurrency.
```

**Concurrency note:** parallel `edit_file` on different paths is allowed. Key snapshots by **absolute path** acquired under write-path (one writer per path). Store `Map<absPath, LspDiagnostic[]>` on the handler; pre sets, post reads/deletes.

Post handler (registered **before** write-path release):

1. If tool not edit_file/batch_edit or result not ok → no-op (still clear any snapshots)
2. Sync + optional format_on_edit (write + invalidate)
3. Diff diagnostics; patch `result.lsp`
4. Clear snapshots for those paths

Register order in `registerBuiltinHooks`:

```ts
registry.onPreToolCall(planMode);
registry.onPreToolCall(writePathPre);
registry.onPreToolCall(lspPre);
registry.onPostToolCall(lspPost);      // first
registry.onPostToolCall(writePathPost); // last — releases lock
```

`registerBuiltinHooks` needs `LspManager` + `clearReadPath` / invalidate callback — extend signature:

```ts
export function registerBuiltinHooks(
  registry: HookRegistry,
  cwd: string,
  opts?: { lsp?: LspManager | null; onFormattedPath?: (abs: string) => void },
): void;
```

Or construct LSP hooks in Session after manager exists and register them there.

- [ ] **Step 3: Post-edit tests**

Use fake server + temporary files:

- Introduced diagnostic appears in `result.lsp.introduced`
- Cleared diagnostic not in introduced
- `format_on_edit=false` does not rewrite
- `format_on_edit=true` rewrites and invalidates read path
- LSP timeout attaches `lsp.warning`, edit remains `ok: true`
- Lock: concurrent read of same path during post-edit still blocked (optional if hard to simulate)

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(lsp): wire session lifecycle and post-edit diagnostics"
```

---

### Task 6: Docs + verification

**Files:**
- Modify: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md` (if code-intel section exists), Phase 1 spec status line
- Update: `docs/superpowers/specs/2026-08-12-tree-sitter-code-intel-design.md` related-work pointer

- [ ] **Step 1: Documentation**

Document `[lsp]`, tools, opt-in format-on-edit, soft-fail behavior, Phase 4 deferrals. Distinguish Tree-sitter syntax diagnostics from LSP diagnostics.

- [ ] **Step 2: Full verification**

```bash
bun typecheck
bun test tests/lsp-*.test.ts tests/hooks.test.ts tests/tools.test.ts tests/plan-mode.test.ts
bun test
```

Compare failures to Task 0 baseline.

- [ ] **Step 3: Final commit (docs)**

```bash
git commit -m "docs: document issue #11 Phase 2 LSP tier"
```

Do not push / open PR unless the user asks.

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| `[lsp]` config defaults / validation | 1 |
| JSON-RPC client + timeout + shutdown | 2 |
| Fake fixture (no real TLS in CI) | 2 |
| Manager lazy start / reuse | 3 |
| TS/JS language mapping | 3 |
| Safe TextEdit apply | 3 |
| `lsp_diagnostics` / `lsp_format` | 4 |
| Sandbox + plan-mode + write-path | 4 |
| Session construct / shutdown | 5 |
| Post-edit snapshot + introduced diff | 5 |
| Opt-in `format_on_edit` under lock | 5 |
| Docs | 6 |
| No Phase 3/4 / no write_file auto pipeline | explicit non-goals |

## Execution handoff

After the user approves this plan and the design spec:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
