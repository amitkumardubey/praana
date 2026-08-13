# Issue #11 Phase 3: LSP Code Intelligence Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship agent-callable LSP hover, completions, semantic definition/references, and list+apply code actions on the existing Phase 2 client.

**Architecture:** Extend `LspClient` initialize + JSON-RPC methods; add pure mappers in `src/lsp/map.ts`; add `CodeActionCache` on `LspManager`; six new tools in `src/tools/lsp.ts`. Tree-sitter `code_*` unchanged. Apply is text edits only (multi-file OK).

**Tech Stack:** TypeScript (strict, NodeNext), Bun test, existing stdio JSON-RPC client, fake LSP fixture. No new npm LSP SDK.

**Spec:** [`docs/superpowers/specs/2026-08-14-lsp-phase3-design.md`](../specs/2026-08-14-lsp-phase3-design.md)

**Branch:** `feat/ad/issue-11-lsp-phase3` (already created; spec committed).

**Out of scope:** WorkspaceEdit create/rename/delete, `workspace/executeCommand`, signature help, languages beyond TS/JS, completions insert/apply, Phase 4 restart/multi-root, bundling servers.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/lsp/map.ts` | 1-based ↔ 0-based coords; hover/completion/location/WorkspaceEdit mappers; caps |
| **Create** `tests/lsp-map.test.ts` | Pure mapper unit tests |
| **Modify** `tests/fixtures/fake-lsp-server.ts` | Script hover/completion/definition/references/codeAction/resolve + capability flags |
| **Modify** `src/lsp/types.ts` | Agent-facing Phase 3 result types |
| **Modify** `src/lsp/client.ts` | Initialize caps + hover/completion/definition/references/codeAction/resolve methods |
| **Modify** `src/lsp/manager.ts` | Query methods, CodeActionCache, apply |
| **Modify** `src/lsp/index.ts` | Re-export mappers/types |
| **Modify** `src/tools/lsp.ts` | Six new tools |
| **Modify** `src/plan-mode.ts` | Block `lsp_apply_code_action` |
| **Modify** `src/hooks/handlers/write-path.ts` | Lock originating + extra apply paths |
| **Modify** `src/hooks/index.ts` | Pass `LspManager` into write-path handlers |
| **Modify** `src/tools/index.ts` | Catalog copy |
| **Modify** `src/ui/tui/tool-icons.ts` | Icons / short labels |
| **Modify** `src/domain/coding-domain.ts` | Classify new query tools as `search_results` |
| **Modify** `src/turn.ts` | Tool-call summaries for position/id args |
| **Modify** `tests/lsp-client.test.ts` | Client method + capability tests |
| **Modify** `tests/lsp-manager.test.ts` | Cache, stale, resolve, multi-file, resource-op reject |
| **Modify** `tests/lsp-tools.test.ts` | Tool envelopes, plan mode, sandbox |
| **Modify** `tests/hooks.test.ts` | Apply write-path lock |
| **Modify** `tests/tools.test.ts`, `tests/compiler.test.ts` | Registry + plan-mode prompt list |
| **Modify** `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md`, `praana.config.example.toml` | Docs |

---

### Task 0: Baseline

**Files:** none (verify)

- [ ] **Step 1: Confirm branch**

```bash
git branch --show-current
# expected: feat/ad/issue-11-lsp-phase3
```

- [ ] **Step 2: Run baseline**

```bash
bun typecheck
bun test
```

Expected: typecheck clean; full suite green (same as `main`). If anything fails, stop and report — do not mix Phase 3 work with a dirty baseline.

- [ ] **Step 3: Commit this plan if untracked**

```bash
git add docs/superpowers/plans/2026-08-14-issue-11-lsp-phase3.md
git commit -m "$(cat <<'EOF'
docs: add issue #11 Phase 3 LSP intelligence implementation plan

EOF
)"
```

---

### Task 1: Pure protocol mappers

**Files:**
- Create: `src/lsp/map.ts`
- Create: `tests/lsp-map.test.ts`
- Modify: `src/lsp/types.ts` (add result types used by mappers)
- Modify: `src/lsp/index.ts`

- [ ] **Step 1: Write failing mapper tests**

Create `tests/lsp-map.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  agentToLspPosition,
  completionKindFromLsp,
  flattenWorkspaceEdit,
  isApplicableCodeAction,
  mapLocations,
  normalizeHover,
  truncateCompletions,
} from "../src/lsp/map.js";
import { pathToFileUri } from "../src/lsp/types.js";

describe("coords", () => {
  it("converts 1-based agent positions to 0-based LSP", () => {
    expect(agentToLspPosition(1, 1)).toEqual({ line: 0, character: 0 });
    expect(agentToLspPosition(3, 5)).toEqual({ line: 2, character: 4 });
  });
});

describe("normalizeHover", () => {
  it("joins MarkupContent and truncates at 2000", () => {
    const hover = normalizeHover({
      contents: { kind: "markdown", value: "x".repeat(2500) },
    });
    expect(hover?.kind).toBe("markdown");
    expect(hover?.contents.length).toBe(2000);
  });

  it("returns null for empty hover", () => {
    expect(normalizeHover(null)).toBeNull();
    expect(normalizeHover({ contents: "" })).toBeNull();
  });
});

describe("completionKindFromLsp", () => {
  it("maps known kinds and omits unknown", () => {
    expect(completionKindFromLsp(3)).toBe("function");
    expect(completionKindFromLsp(16)).toBe("other");
    expect(completionKindFromLsp(99)).toBeUndefined();
    expect(completionKindFromLsp(undefined)).toBeUndefined();
  });
});

describe("truncateCompletions", () => {
  it("caps at 20 and sets truncated", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      label: `c${i}`,
      insertText: "NOPE",
      detail: "d".repeat(300),
      kind: 3,
    }));
    const result = truncateCompletions(items);
    expect(result.completions).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.completions[0]).toEqual({
      label: "c0",
      kind: "function",
      detail: "d".repeat(200),
    });
    expect("insertText" in result.completions[0]!).toBe(false);
  });
});

describe("mapLocations", () => {
  const root = "/proj";
  it("maps LocationLink via targetSelectionRange and drops outside-root URIs", () => {
    const inside = pathToFileUri("/proj/src/a.ts");
    const outside = pathToFileUri("/elsewhere/b.ts");
    const locs = mapLocations(
      [
        {
          targetUri: inside,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 10, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 9 },
          },
        },
        {
          targetUri: outside,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 0 },
          },
        },
      ],
      root,
    );
    expect(locs).toEqual([
      {
        path: "/proj/src/a.ts",
        startLine: 3,
        startCol: 5,
        endLine: 3,
        endCol: 10,
      },
    ]);
  });
});

describe("flattenWorkspaceEdit", () => {
  it("collects text edits from changes and documentChanges", () => {
    const flat = flattenWorkspaceEdit({
      changes: {
        "file:///proj/a.ts": [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            newText: "A",
          },
        ],
      },
    });
    expect(flat.ok).toBe(true);
    if (flat.ok) expect(flat.files.has("/proj/a.ts")).toBe(true);
  });

  it("rejects create/rename/delete resource ops", () => {
    const flat = flattenWorkspaceEdit({
      documentChanges: [{ kind: "create", uri: "file:///proj/n.ts" }],
    });
    expect(flat.ok).toBe(false);
    if (!flat.ok) expect(flat.reason).toBe("resource_op");
  });
});

describe("isApplicableCodeAction", () => {
  it("keeps edit-bearing and resolvable-data actions; drops command-only", () => {
    expect(
      isApplicableCodeAction(
        { title: "fix", edit: { changes: { "file:///a.ts": [] } } },
        false,
      ),
    ).toBe(true);
    expect(
      isApplicableCodeAction({ title: "fix", data: { x: 1 } }, true),
    ).toBe(true);
    expect(
      isApplicableCodeAction({ title: "fix", command: "do.it" }, true),
    ).toBe(false);
    expect(
      isApplicableCodeAction({ title: "fix", data: { x: 1 } }, false),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect fail**

```bash
bun test tests/lsp-map.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Add types + implement mappers**

Append to `src/lsp/types.ts`:

```ts
export interface LspHover {
  contents: string;
  kind: "markdown" | "plaintext";
}

export type CompletionKind =
  | "text"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "variable"
  | "class"
  | "interface"
  | "module"
  | "property"
  | "enum"
  | "keyword"
  | "snippet"
  | "file"
  | "folder"
  | "enumMember"
  | "constant"
  | "struct"
  | "operator"
  | "typeParameter"
  | "other";

export interface LspCompletionItem {
  label: string;
  kind?: CompletionKind;
  detail?: string;
}

export interface LspLocation {
  path: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface LspCodeActionRow {
  id: string;
  title: string;
  kind?: string;
  preferred?: boolean;
}
```

Create `src/lsp/map.ts` with the functions the tests import. Required constants and behavior:

```ts
export const HOVER_MAX_CHARS = 2000;
export const COMPLETION_MAX = 20;
export const DETAIL_MAX_CHARS = 200;
export const DEFINITION_MAX = 20;
export const REFERENCES_MAX = 50;
export const CODE_ACTIONS_MAX = 20;

export function agentToLspPosition(line: number, col: number): LspPosition {
  return { line: line - 1, character: col - 1 };
}

export function agentToLspRange(
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): LspRange {
  return {
    start: agentToLspPosition(startLine, startCol),
    end: agentToLspPosition(endLine, endCol),
  };
}
```

`completionKindFromLsp` — exact table from the spec (1=`text` … 25=`typeParameter`; 11/12/16/18/23 → `other`).

`normalizeHover(raw)` — accept `null` / `{ contents }`. Flatten string | `{ value, kind? }` | `{ language, value }` | arrays; if any part has `kind === "markdown"` or looks like MarkupContent markdown, `kind` is `"markdown"` else `"plaintext"`. Trim; empty → `null`. Slice to `HOVER_MAX_CHARS`.

`truncateCompletions(items)` — take `.items` if given a `CompletionList`, else array. Map `{ label, kind: completionKindFromLsp(kind), detail?: slice(0, 200) }`. Omit empty label. Cap 20; `truncated` if source length > 20. Never copy `insertText` / `textEdit` / `additionalTextEdits` / `documentation`.

`mapLocations(raw, workspaceRoot)` — normalize single Location, array, LocationLink array, or null → `LspLocation[]`. LocationLink uses `targetSelectionRange` ?? `targetRange` and `targetUri`. Convert URI with `fileUriToPath`. Drop if path is null or not `path === root || path.startsWith(root + "/")`. 1-based via `+ 1` on line/character.

`flattenWorkspaceEdit(edit)`:

```ts
export type FlattenOk = {
  ok: true;
  files: Map<string, LspTextEdit[]>;
};
export type FlattenErr = { ok: false; reason: "resource_op" | "invalid_uri" };
```

Walk `changes` (uri → TextEdit[]) and `documentChanges`. If an entry has `kind` of `create` | `rename` | `delete`, return `{ ok: false, reason: "resource_op" }`. `TextDocumentEdit` uses `textDocument.uri` + `edits`. Ignore `annotationId`. Invalid/non-file URI → `invalid_uri`.

`isApplicableCodeAction(action, resolveProvider)` — object with `title`; true if `edit` is a non-null object, OR (`data !== undefined && resolveProvider`). Command-only (`command` set, no `edit`, no resolvable `data`) → false.

- [ ] **Step 4: Re-export from `src/lsp/index.ts`**

Add exports for the new types and mapper functions used by tools/tests.

- [ ] **Step 5: Run tests — expect pass**

```bash
bun test tests/lsp-map.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lsp/map.ts src/lsp/types.ts src/lsp/index.ts tests/lsp-map.test.ts
git commit -m "$(cat <<'EOF'
feat(lsp): add Phase 3 protocol mappers for hover and edits

EOF
)"
```

---

### Task 2: Extend the fake LSP fixture

**Files:**
- Modify: `tests/fixtures/fake-lsp-server.ts`

- [ ] **Step 1: Add env-scripted Phase 3 methods**

At the top, next to existing `FAKE_LSP_*` parsing, add:

```ts
const noHover = process.env.FAKE_LSP_NO_HOVER === "1";
const noCompletion = process.env.FAKE_LSP_NO_COMPLETION === "1";
const noDefinition = process.env.FAKE_LSP_NO_DEFINITION === "1";
const noReferences = process.env.FAKE_LSP_NO_REFERENCES === "1";
const noCodeAction = process.env.FAKE_LSP_NO_CODE_ACTION === "1";
const resolveProvider = process.env.FAKE_LSP_RESOLVE === "1";

const scriptedHover = parseJsonEnv<unknown>("FAKE_LSP_HOVER", {
  contents: { kind: "markdown", value: "hover-doc" },
});
const scriptedCompletions = parseJsonEnv<unknown[]>("FAKE_LSP_COMPLETIONS", []);
const scriptedDefinition = parseJsonEnv<unknown>("FAKE_LSP_DEFINITION", null);
const scriptedReferences = parseJsonEnv<unknown[]>("FAKE_LSP_REFERENCES", []);
const scriptedCodeActions = parseJsonEnv<unknown[]>("FAKE_LSP_CODE_ACTIONS", []);
const scriptedResolvedEdit = parseJsonEnv<unknown>("FAKE_LSP_RESOLVED_EDIT", null);
```

In `initialize` capabilities, merge:

```ts
hoverProvider: !noHover,
completionProvider: noCompletion ? undefined : {},
definitionProvider: !noDefinition,
referencesProvider: !noReferences,
codeActionProvider: noCodeAction
  ? undefined
  : resolveProvider
    ? { resolveProvider: true }
    : true,
```

Handle requests (after formatting, before shutdown):

```ts
if (method === "textDocument/hover") {
  await maybeDelay();
  write({ jsonrpc: "2.0", id, result: scriptedHover });
  return;
}
if (method === "textDocument/completion") {
  await maybeDelay();
  write({ jsonrpc: "2.0", id, result: scriptedCompletions });
  return;
}
if (method === "textDocument/definition") {
  await maybeDelay();
  write({ jsonrpc: "2.0", id, result: scriptedDefinition });
  return;
}
if (method === "textDocument/references") {
  await maybeDelay();
  write({ jsonrpc: "2.0", id, result: scriptedReferences });
  return;
}
if (method === "textDocument/codeAction") {
  await maybeDelay();
  write({ jsonrpc: "2.0", id, result: scriptedCodeActions });
  return;
}
if (method === "codeAction/resolve") {
  await maybeDelay();
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  write({
    jsonrpc: "2.0",
    id,
    result: { ...params, edit: scriptedResolvedEdit },
  });
  return;
}
```

Keep the unknown-method error fallback so missing handlers still fail loudly.

- [ ] **Step 2: Existing Phase 2 tests still pass**

```bash
bun test tests/lsp-client.test.ts tests/lsp-manager.test.ts tests/lsp-tools.test.ts tests/lsp-config.test.ts tests/lsp-framing.test.ts
```

Expected: PASS (initialize still returns `documentFormattingProvider` unless `FAKE_LSP_NO_FORMAT=1`).

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/fake-lsp-server.ts
git commit -m "$(cat <<'EOF'
test(lsp): script Phase 3 methods on the fake language server

EOF
)"
```

---

### Task 3: LspClient methods + capabilities

**Files:**
- Modify: `src/lsp/client.ts`
- Modify: `tests/lsp-client.test.ts`

- [ ] **Step 1: Write failing client tests**

Append to `tests/lsp-client.test.ts`:

```ts
  it("reports hover/definition capabilities and returns hover", async () => {
    const client = await LspClient.start({
      command: fakeArgv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: 3000,
      env: {
        FAKE_LSP_HOVER: JSON.stringify({
          contents: { kind: "plaintext", value: "number" },
        }),
      },
    });
    try {
      expect(client.supportsHover).toBe(true);
      const file = join(root, "h.ts");
      await client.didOpen(file, "typescript", "const n = 1;\n");
      const hover = await client.hover(file, { line: 0, character: 6 });
      expect(hover).toEqual({
        contents: { kind: "plaintext", value: "number" },
      });
    } finally {
      await client.shutdown();
    }
  });

  it("skips hover when server omits the capability", async () => {
    const client = await LspClient.start({
      command: fakeArgv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: 3000,
      env: { FAKE_LSP_NO_HOVER: "1" },
    });
    try {
      expect(client.supportsHover).toBe(false);
    } finally {
      await client.shutdown();
    }
  });
```

(`hover()` on the client returns the **raw** LSP result; mapping happens in the manager. If you prefer the client to return `unknown`, assert `contents` accordingly.)

- [ ] **Step 2: Run — expect fail**

```bash
bun test tests/lsp-client.test.ts
```

Expected: FAIL (`supportsHover` missing).

- [ ] **Step 3: Implement client**

In `LspClient.start` initialize params, replace `textDocument` capabilities with:

```ts
textDocument: {
  publishDiagnostics: {},
  formatting: {},
  hover: { contentFormat: ["markdown", "plaintext"] },
  completion: { completionItem: { snippetSupport: false } },
  definition: { linkSupport: true },
  references: {},
  codeAction: { resolveSupport: { properties: ["edit"] } },
},
```

Parse `InitializeResult.capabilities` into booleans (same `Boolean()` pattern as formatting). `resolveProvider` is nested: `typeof codeActionProvider === "object" && codeActionProvider.resolveProvider`.

Add getters: `supportsHover`, `supportsCompletion`, `supportsDefinition`, `supportsReferences`, `supportsCodeAction`, `supportsResolve`.

Add methods that `request()` and return the raw result (or throw `LspClientError("unsupported", …)` if the getter is false — **manager** will catch this and convert to skip; alternatively methods do not throw and manager checks getters first. **Do the manager-checks-getters approach** so the client methods assume capability is present):

```ts
async hover(absPath: string, position: LspPosition): Promise<unknown> {
  return this.request("textDocument/hover", {
    textDocument: { uri: pathToFileUri(absPath) },
    position,
  });
}

async completion(absPath: string, position: LspPosition): Promise<unknown> { /* textDocument/completion */ }
async definition(absPath: string, position: LspPosition): Promise<unknown> { /* textDocument/definition */ }
async references(absPath: string, position: LspPosition): Promise<unknown> {
  return this.request("textDocument/references", {
    textDocument: { uri: pathToFileUri(absPath) },
    position,
    context: { includeDeclaration: true },
  });
}
async codeAction(absPath: string, range: LspRange): Promise<unknown> {
  return this.request("textDocument/codeAction", {
    textDocument: { uri: pathToFileUri(absPath) },
    range,
    context: { diagnostics: [] },
  });
}
async resolveCodeAction(action: unknown): Promise<unknown> {
  return this.request("codeAction/resolve", action);
}
```

- [ ] **Step 4: Run — expect pass**

```bash
bun test tests/lsp-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lsp/client.ts tests/lsp-client.test.ts
git commit -m "$(cat <<'EOF'
feat(lsp): request hover, completion, definition, references, and code actions

EOF
)"
```

---

### Task 4: Manager queries + CodeActionCache + apply

**Files:**
- Modify: `src/lsp/manager.ts`
- Modify: `tests/lsp-manager.test.ts`

- [ ] **Step 1: Write failing manager tests**

Append to `tests/lsp-manager.test.ts` (reuse `baseConfig` + tmpdir pattern already in the file):

```ts
describe("Phase 3 queries", () => {
  it("returns hover via fake server", async () => {
    writeFileSync(join(dir, "a.ts"), "const n = 1;\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_HOVER: JSON.stringify({
              contents: { kind: "plaintext", value: "n: number" },
            }),
          },
        }),
    });
    try {
      const result = await mgr.hover(join(dir, "a.ts"), 1, 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toBeUndefined();
        expect(result.value.hover).toEqual({
          contents: "n: number",
          kind: "plaintext",
        });
      }
    } finally {
      await mgr.shutdown();
    }
  });

  it("skips hover when capability is off", async () => {
    writeFileSync(join(dir, "a.ts"), "x\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({ ...opts, env: { FAKE_LSP_NO_HOVER: "1" } }),
    });
    try {
      const result = await mgr.hover(join(dir, "a.ts"), 1, 1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.skipped).toBe("unsupported");
    } finally {
      await mgr.shutdown();
    }
  });

  it("lists applicable actions with opaque ids and applies text edits", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "x\n");
    const uri = pathToFileUri(path);
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_CODE_ACTIONS: JSON.stringify([
              {
                title: "Add comment",
                kind: "quickfix",
                edit: {
                  changes: {
                    [uri]: [
                      {
                        range: {
                          start: { line: 0, character: 0 },
                          end: { line: 0, character: 0 },
                        },
                        newText: "// ok\n",
                      },
                    ],
                  },
                },
              },
              { title: "Command only", command: "do.it" },
            ]),
          },
        }),
    });
    try {
      const listed = await mgr.codeActions(path, 1, 1, 1, 1);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.actions).toHaveLength(1);
      expect(listed.value.actions[0]?.title).toBe("Add comment");
      expect(listed.value.actions[0]?.id).toMatch(/^ca_\d+$/);

      const applied = await mgr.applyCodeAction(listed.value.actions[0]!.id);
      expect(applied.ok).toBe(true);
      if (applied.ok) expect(applied.value.changed).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("// ok\nx\n");
    } finally {
      await mgr.shutdown();
    }
  });

  it("rejects stale ids after the file changes", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "x\n");
    const uri = pathToFileUri(path);
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_CODE_ACTIONS: JSON.stringify([
              {
                title: "noop",
                edit: { changes: { [uri]: [] } },
              },
            ]),
          },
        }),
    });
    try {
      const listed = await mgr.codeActions(path, 1, 1, 1, 1);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      writeFileSync(path, "changed\n");
      const applied = await mgr.applyCodeAction(listed.value.actions[0]!.id);
      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.code).toBe("invalid_argument");
    } finally {
      await mgr.shutdown();
    }
  });

  it("rejects resource-op workspace edits without writing", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "x\n");
    const mgr = new LspManager({
      config: baseConfig(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        LspClient.start({
          ...opts,
          env: {
            FAKE_LSP_RESOLVE: "1",
            FAKE_LSP_CODE_ACTIONS: JSON.stringify([
              { title: "Extract file", data: { id: 1 } },
            ]),
            FAKE_LSP_RESOLVED_EDIT: JSON.stringify({
              documentChanges: [
                { kind: "create", uri: pathToFileUri(join(dir, "b.ts")) },
              ],
            }),
          },
        }),
    });
    try {
      const listed = await mgr.codeActions(path, 1, 1, 1, 1);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const applied = await mgr.applyCodeAction(listed.value.actions[0]!.id);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.value.skipped).toBe("unsupported");
        expect(applied.value.changed).toBe(false);
      }
      expect(existsSync(join(dir, "b.ts"))).toBe(false);
    } finally {
      await mgr.shutdown();
    }
  });
});
```

Import `LspClient`, `pathToFileUri`, `readFileSync`, `existsSync` as needed. Use the same `dir` tmpdir `beforeEach` as existing manager tests (if Phase 3 describe has its own `dir`, copy the existing beforeEach/afterEach).

- [ ] **Step 2: Run — expect fail**

```bash
bun test tests/lsp-manager.test.ts
```

Expected: FAIL (`mgr.hover` is not a function).

- [ ] **Step 3: Implement manager**

On `LspManager` add:

```ts
private readonly actions = new Map<string, {
  id: string;
  language: string;
  path: string;
  mtimeMs: number;
  version: number;
  action: unknown;
}>();
private nextActionId = 1;
private readonly docVersion = new Map<string, number>();
```

Increment `docVersion` in `syncDocument` (open → 1, each change → previous+1). Pass that version into `didChange`.

Helpers:

- `validatePosition(line, col)` → `invalid_argument` if not finite integers `>= 1`.
- `mtimeOf(absPath)` via `statSync`.
- `originatingPathForAction(id): string | null` — public, used by write-path hook.
- `dropActionsForPaths(paths: string[])` — delete cache entries whose `path` is in the set.

Query methods all: `if (!enabled) err("disabled")`; `prepareDocument`; if `!client.supportsX` return `{ ok: true, value: { skipped: "unsupported", hover: null | completions: [] | locations: [] | actions: [] } }`; else call client; map; cap.

```ts
async hover(absPath: string, line: number, col: number): Promise<LspResult<{
  hover: LspHover | null;
  skipped?: "unsupported";
}>> { /* ... */ }

async completions(...) // value: { completions, truncated?, skipped? }
async definition(...)   // value: { locations, truncated?, skipped? } cap DEFINITION_MAX
async references(...)   // cap REFERENCES_MAX
```

`codeActions(absPath, startLine, startCol, endLine, endCol)`:

1. prepareDocument + capability check.
2. `client.codeAction(absPath, agentToLspRange(...))`.
3. Filter with `isApplicableCodeAction(item, client.supportsResolve)`. Treat Command-shaped items (string `command`, no `title`+`edit`) as not applicable.
4. Drop previous cache entries with the same `path`.
5. For each remaining item (cap 20, set `truncated`): `id = "ca_" + nextActionId++`; store `{ id, language, path: absPath, mtimeMs, version: docVersion.get(absPath) ?? 1, action }`.
6. Return compact rows.

`applyCodeAction(id, opts?: { allowPath?: (abs: string) => boolean; acquireExtra?: (abs: string) => { ok: true } | { ok: false; error: string }; releaseExtra?: (abs: string) => void })`:

1. Lookup; missing → `invalid_argument` `"Unknown code action id; call lsp_code_actions again"`.
2. If `mtimeOf(entry.path) !== entry.mtimeMs` → same error with `"stale"` in the message.
3. `action = entry.action`. If no `edit` and `supportsResolve`, `action = await client.resolveCodeAction(action)`.
4. `flattenWorkspaceEdit(action.edit)`. `resource_op` → `{ ok: true, value: { id, changed: false, files: [], skipped: "unsupported" } }`. Missing edit → `skipped: "unsupported"`.
5. For each target path: must exist as a file; must be under `workspaceRoot`; `allowPath?.(p) !== false` else `invalid_argument`.
6. Read each file, `applyTextEdits` in memory. Any `protocol_error` → return that, write nothing.
7. If all contents unchanged → `{ changed: false, skipped: "no_edits", files }`.
8. Additional paths (not originating): `acquireExtra`; on failure return `{ ok: false, code: "invalid_argument", error }` after releasing extras already taken. (Originating path is locked by the pre-hook.)
9. `writeFileSync` each changed file; `openDocs.delete` + `syncDocument`; `dropActionsForPaths`.
10. Return `{ id, changed: true, files: [{ path, changed }] }`.

If a write throws after validation, `io_error` (no rollback journal).

On `shutdown()`, `actions.clear()`.

- [ ] **Step 4: Run — expect pass**

```bash
bun test tests/lsp-manager.test.ts tests/lsp-map.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lsp/manager.ts tests/lsp-manager.test.ts
git commit -m "$(cat <<'EOF'
feat(lsp): add hover, completions, def/refs, and code-action apply

EOF
)"
```

---

### Task 5: Agent tools

**Files:**
- Modify: `src/tools/lsp.ts`
- Modify: `tests/lsp-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Append to `tests/lsp-tools.test.ts`:

```ts
  it("lsp_hover is 1-based and returns mapped hover", async () => {
    writeFileSync(join(dir, "a.ts"), "const n = 1;\n");
    const mgr = new LspManager({
      config: cfg(),
      cwd: dir,
      workspaceRoot: dir,
      startClient: (opts) =>
        import("../src/lsp/client.js").then(({ LspClient }) =>
          LspClient.start({
            ...opts,
            env: {
              FAKE_LSP_HOVER: JSON.stringify({
                contents: { kind: "plaintext", value: "number" },
              }),
            },
          }),
        ),
    });
    try {
      const tools = createLspTools({ cwd: dir, getLsp: () => mgr });
      const result = await tools.lsp_hover.execute({
        path: "a.ts",
        line: 1,
        col: 7,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.hover).toEqual({ contents: "number", kind: "plaintext" });
        expect(result.line).toBe(1);
      }
    } finally {
      await mgr.shutdown();
    }
  });

  it("rejects non-positive coordinates", async () => {
    writeFileSync(join(dir, "a.ts"), "x\n");
    const mgr = new LspManager({
      config: cfg(),
      cwd: dir,
      workspaceRoot: dir,
    });
    try {
      const tools = createLspTools({ cwd: dir, getLsp: () => mgr });
      const result = await tools.lsp_hover.execute({
        path: "a.ts",
        line: 0,
        col: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_argument");
    } finally {
      await mgr.shutdown();
    }
  });

  it("blocks lsp_apply_code_action in the plan-mode set, not query tools", () => {
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_apply_code_action")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_hover")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_code_actions")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("lsp_definition")).toBe(false);
  });
```

- [ ] **Step 2: Run — expect fail**

```bash
bun test tests/lsp-tools.test.ts
```

Expected: FAIL (`lsp_hover` missing). Plan-mode assertion also fails until Task 6; **either add `lsp_apply_code_action` to `PLAN_MODE_BLOCKED_TOOLS` in this task** (one-line) **or keep that assertion in Task 6**. Prefer adding the plan-mode set entry here so this test can pass, then Task 6 covers write-path + compiler string.

- [ ] **Step 3: Implement tools**

Shared `coordSchema`:

```ts
const coordSchema = z.number().int().positive();
```

Helper `withManager` — same missing-manager envelope as existing tools.

`ensureFilePath` then `mgr.*`. On manager `ok: false`, pass through `{ ok: false, error, code }`.

On success, tools add `path` (absolute), `language: languageFromPath(abs)`, and the query fields (`line`/`col` or `range`). Include `skipped` only when present.

`lsp_apply_code_action`:

```ts
parameters: z.object({
  id: z.string().min(1).describe("Opaque id from lsp_code_actions"),
}),
execute: async (args) => {
  const mgr = ctx.getLsp();
  if (!mgr) return { ok: false as const, error: "LSP unavailable: manager not initialized", code: "unavailable" };
  const result = await mgr.applyCodeAction(args.id, {
    allowPath: (abs) => sandboxBlockReason(abs, ctx.sandbox) === null,
  });
  if (!result.ok) return { ok: false as const, error: result.error, code: result.code };
  for (const f of result.value.files) {
    if (f.changed) ctx.clearReadPath?.(f.path);
  }
  return { ok: true as const, ...result.value };
},
```

Descriptions (agent-facing):

- `lsp_hover` — “Type and documentation at a 1-based position via LSP. Soft-fails when disabled. Prefer code_* for fast in-project name queries.”
- `lsp_completions` — “Up to 20 completion labels at a position (no insert/apply).”
- `lsp_definition` — “Semantic definition locations at a position (stdlib/deps). Use code_definition for name-based project search.”
- `lsp_references` — “Semantic references at a position. Use code_references for name-based project search.”
- `lsp_code_actions` — “List applicable LSP code actions for a 1-based range. Returns opaque ids for lsp_apply_code_action.”
- `lsp_apply_code_action` — “Apply a listed code action by id (text edits only; mutating).”

- [ ] **Step 4: Add plan-mode block (one line)**

In `src/plan-mode.ts` `PLAN_MODE_BLOCKED_TOOLS`, add `"lsp_apply_code_action"`.

- [ ] **Step 5: Run — expect pass**

```bash
bun test tests/lsp-tools.test.ts
```

Expected: PASS. `tests/compiler.test.ts` will fail until Task 7 updates the expected plan-mode string — that is OK if you have not run the full suite yet. Do **not** leave compiler broken across the Task 7 commit; if you run full `bun test` now, update the compiler expectation in the same commit as the plan-mode set (see Task 7 Step 1). **Do that compiler assertion update now** so `bun test` stays green:

In `tests/compiler.test.ts` change the blocked-tool list to the sorted set:

`batch_edit, batch_write, edit_file, git_commit, lsp_apply_code_action, lsp_format, write_file`

- [ ] **Step 6: Commit**

```bash
git add src/tools/lsp.ts src/plan-mode.ts tests/lsp-tools.test.ts tests/compiler.test.ts
git commit -m "$(cat <<'EOF'
feat(lsp): expose Phase 3 hover, completions, def/refs, and code-action tools

EOF
)"
```

---

### Task 6: Write-path locking for apply

**Files:**
- Modify: `src/hooks/handlers/write-path.ts`
- Modify: `src/hooks/index.ts`
- Modify: `tests/hooks.test.ts`

- [ ] **Step 1: Write failing hook test**

In `tests/hooks.test.ts`, add a test that constructs `LspManager` + `registerBuiltinHooks` with `lspManager`, lists an action (or stubs `originatingPathForAction`), then:

```ts
it("locks the originating path for lsp_apply_code_action", async () => {
  // Minimal: manager with originatingPathForAction returning abs path
  const dir = /* tmpdir with a.ts */;
  const mgr = new LspManager({ /* fake server + one cached action via codeActions */ });
  const registry = new HookRegistry();
  registerBuiltinHooks(registry, dir, { lspManager: mgr });
  const session = fakeSession({ cwd: dir });

  const listed = await mgr.codeActions(join(dir, "a.ts"), 1, 1, 1, 1);
  const id = listed.ok ? listed.value.actions[0]!.id : "";

  const first = await registry.runPreToolCall({
    toolName: "lsp_apply_code_action",
    args: { id },
    session,
  });
  expect(first.action).toBe("continue");

  const second = await registry.runPreToolCall({
    toolName: "edit_file",
    args: { path: "a.ts", oldText: "x", newText: "y" },
    session,
  });
  expect(second.action).toBe("block");
});
```

Also: unknown id does **not** block in the pre-hook (tool returns `invalid_argument`).

- [ ] **Step 2: Run — expect fail**

```bash
bun test tests/hooks.test.ts
```

Expected: FAIL (apply is not in `WRITE_TOOLS` / paths not resolved from id).

- [ ] **Step 3: Implement**

`WRITE_TOOLS` add `"lsp_apply_code_action"`.

Extend handlers:

```ts
export function createWritePathPreToolCallHandler(
  guard: WritePathGuard,
  opts?: { originatingPathForApply?: (id: string) => string | null },
): PreToolCallHandler
```

In `relPathsFromArgs`, when `toolName === "lsp_apply_code_action"` return `[]` (paths come from opts).

In the pre handler, after the existing loop:

```ts
if (ctx.toolName === "lsp_apply_code_action") {
  const id = typeof ctx.args.id === "string" ? ctx.args.id : "";
  const abs = id ? opts?.originatingPathForApply?.(id) : null;
  if (!abs) return; // cache miss — tool fails later
  const result = guard.tryAcquire(abs, abs);
  if (!result.ok) {
    return { action: "block", isError: false, error: result.error };
  }
  guard.rememberApply(id, [abs]);
  return;
}
```

Add on `WritePathGuard`:

```ts
private readonly applyLocks = new Map<string, string[]>();

rememberApply(id: string, paths: string[]): void {
  const prev = this.applyLocks.get(id) ?? [];
  this.applyLocks.set(id, [...prev, ...paths.filter((p) => !prev.includes(p))]);
}

releaseApply(id: string): void {
  for (const p of this.applyLocks.get(id) ?? []) this.release(p);
  this.applyLocks.delete(id);
}

tryAcquireExtra(id: string, absPath: string, relPath: string) {
  const result = this.tryAcquire(absPath, relPath);
  if (result.ok) this.rememberApply(id, [absPath]);
  return result;
}
```

Post handler: if `lsp_apply_code_action`, `guard.releaseApply(String(args.id ?? ""))` and return (do not also release empty relPaths).

`registerBuiltinHooks`:

```ts
registry.onPreToolCall(
  createWritePathPreToolCallHandler(writePath, {
    originatingPathForApply: (id) =>
      opts?.lspManager?.originatingPathForAction(id) ?? null,
  }),
);
registry.onPostToolCall(
  createWritePathPostToolCallHandler(writePath),
);
```

Pass `acquireExtra` / `releaseExtra` into `applyCodeAction` from the **tool** by giving `createLspTools` an optional `writePath` — **avoid that**. Extra-file locks happen inside the manager via an optional callback set by hooks:

```ts
// LspManager
setApplyLock(lock: {
  tryAcquireExtra(id: string, absPath: string): { ok: true } | { ok: false; error: string };
} | null): void
```

In `registerBuiltinHooks`, after creating `writePath`:

```ts
opts?.lspManager?.setApplyLock({
  tryAcquireExtra: (id, absPath) => writePath.tryAcquireExtra(id, absPath, absPath),
});
```

Manager apply step 8 uses `this.applyLock?.tryAcquireExtra`. On failure, `this.applyLock` cannot roll back extras except `releaseApply` — add `releaseExtrasOnly` or call `writePath.release` on extras acquired in this step (track local `acquiredExtra[]` and release those on failure; originating stays held until post).

- [ ] **Step 4: Run — expect pass**

```bash
bun test tests/hooks.test.ts tests/lsp-tools.test.ts tests/lsp-manager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/write-path.ts src/hooks/index.ts src/lsp/manager.ts tests/hooks.test.ts
git commit -m "$(cat <<'EOF'
feat(lsp): serialize code-action apply on the write-path lock

EOF
)"
```

---

### Task 7: Catalog, icons, domain, summaries

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/ui/tui/tool-icons.ts`
- Modify: `src/domain/coding-domain.ts`
- Modify: `src/turn.ts`
- Modify: `tests/tools.test.ts`

- [ ] **Step 1: Failing registry test**

In `tests/tools.test.ts` `createAllTools registers code_* tools` loop, add:

```ts
'lsp_hover',
'lsp_completions',
'lsp_definition',
'lsp_references',
'lsp_code_actions',
'lsp_apply_code_action',
```

Add a `describeTools` assertion that classic and engine catalogs contain `lsp_hover` and the `code_definition` vs `lsp_definition` split language.

- [ ] **Step 2: Run — expect fail**

```bash
bun test tests/tools.test.ts
```

Expected: FAIL (describeTools missing new lines). Tools already exist on the object from Task 5.

- [ ] **Step 3: Implement catalog + chrome**

`src/tools/index.ts` `SHARED_TOOL_DESCRIPTIONS` — after `lsp_format`:

```ts
"lsp_hover(path, line, col) — LSP type/docs at a 1-based position (requires [lsp]; use code_* for fast name queries)",
"lsp_completions(path, line, col) — Up to 20 LSP completion labels at a position (no insert)",
"lsp_definition(path, line, col) — Semantic LSP definition at a position (stdlib/deps); code_definition is name-based in-project",
"lsp_references(path, line, col) — Semantic LSP references at a position; code_references is name-based in-project",
"lsp_code_actions(path, startLine, startCol, endLine, endCol) — List applicable LSP quick fixes (opaque ids)",
"lsp_apply_code_action(id) — Apply a listed code action (text edits only; mutating)",
```

`src/ui/tui/tool-icons.ts` — add unicode/ascii/short for the six tools (hover `◎`/`lh`/`lsp-hover`, completions `…`/`lc`/`lsp-comp`, definition `→`/`lD`/`lsp-def`, references `↩`/`lR`/`lsp-refs`, actions `⚡`/`la`/`lsp-act`, apply `✎`/`lA`/`lsp-apply`). Do not collide with existing `lsp_diagnostics`/`lsp_format` keys.

`src/domain/coding-domain.ts` — add `lsp_hover`, `lsp_completions`, `lsp_definition`, `lsp_references`, `lsp_code_actions` to the `search_results` tool-name list next to `lsp_diagnostics`. Leave `lsp_apply_code_action` unclassified (edit-like).

`src/turn.ts` `summarizeToolArgs` — for hover/completions/definition/references: `` `${path}:${line}:${col}` ``; for code_actions include range; for apply: the `id`.

- [ ] **Step 4: Run**

```bash
bun test tests/tools.test.ts tests/compiler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts src/ui/tui/tool-icons.ts src/domain/coding-domain.ts src/turn.ts tests/tools.test.ts
git commit -m "$(cat <<'EOF'
feat(lsp): catalog Phase 3 tools and distinguish them from code_*

EOF
)"
```

---

### Task 8: Docs

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/concepts.md`
- Modify: `praana.config.example.toml`
- Modify: `docs/superpowers/specs/2026-08-14-lsp-phase3-design.md` (status)

- [ ] **Step 1: Update AGENTS.md LSP section**

Replace the tools sentence with:

```
Tools: `lsp_diagnostics(path)`, `lsp_format(path)`, `lsp_hover(path, line, col)`,
`lsp_completions(path, line, col)`, `lsp_definition(path, line, col)`,
`lsp_references(path, line, col)`, `lsp_code_actions(path, range)`,
`lsp_apply_code_action(id)`. Soft-fail when disabled or the server is missing.

Tree-sitter `code_*` stays the fast in-project name path. Use `lsp_definition` /
`lsp_references` when you need types, stdlib, or node_modules. Completions are
labels only (cap 20) — insert via `edit_file`. Apply is text edits only.
```

Architecture map line: `lsp.ts — lsp_diagnostics / lsp_format / hover / completions / definition / references / code actions (issue #11 Phase 3)`.

- [ ] **Step 2: ARCHITECTURE.md + concepts.md**

Same two-tier sentence: Phase 3 tools listed; `code_*` vs `lsp_*` split; plan mode blocks `lsp_apply_code_action` as well as `lsp_format`.

`praana.config.example.toml` — comment that Phase 3 tools share `[lsp]` (no new keys).

Spec status → `Plan written; implementing on feat/ad/issue-11-lsp-phase3`.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/ARCHITECTURE.md docs/concepts.md praana.config.example.toml docs/superpowers/specs/2026-08-14-lsp-phase3-design.md
git commit -m "$(cat <<'EOF'
docs: document issue #11 Phase 3 LSP intelligence tools

EOF
)"
```

---

### Task 9: Full verification

- [ ] **Step 1: Typecheck + full suite**

```bash
bun typecheck
bun test
```

Expected: both clean. Fix any breakage (especially `tests/compiler.test.ts` plan-mode list and TUI icon tests if they snapshot keys).

- [ ] **Step 2: Focused LSP files one more time**

```bash
bun test tests/lsp-map.test.ts tests/lsp-client.test.ts tests/lsp-manager.test.ts tests/lsp-tools.test.ts tests/hooks.test.ts tests/lsp-config.test.ts tests/lsp-framing.test.ts
```

Expected: PASS.

- [ ] **Step 3: No extra issue; #11 already has the deferred comment**

Do not open a new GitHub issue. Resource ops / executeCommand / signature help / extra languages stay on #11 as already commented.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Hover / completions / def / refs / list+apply | 3–5 |
| Keep `code_*` + document split | 7–8 |
| Completions cap 20, no insert | 1, 4 |
| Position-based def/refs, 1-based | 1, 5 |
| Opaque ids, stale mtime | 4 |
| Text edits only; reject resource ops | 1, 4 |
| Command-only omitted | 1, 4 |
| `codeAction/resolve` | 2, 4 |
| Capability skip `unsupported` | 3–4 |
| Plan mode blocks apply only | 5 |
| Write-path originating + extras | 6 |
| TS/JS only | no language.ts change |
| Fake fixture, no real tsserver | 2, 9 |
| Docs + #11 deferred (already commented) | 8, 9 |

No TBD/TODO placeholders. Types (`LspHover`, `ca_<n>`, `skipped: "unsupported"`) are consistent across tasks.
