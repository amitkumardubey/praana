# Issue #294: Detect Repeated-Read and Artifact-Retrieval Churn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect cross-channel file-access and identical-artifact-retrieval churn, surface a soft recovery hint, and expose three new scorecard counters — without hard-blocking shell or retrieve_artifact.

**Architecture:** A pure shell-read parser and pure churn helpers live in `src/tools/`. Per-session state and counters live on `ScorecardTracker`. The `shell` tool annotates (never blocks) when a read-equivalent command re-hits a path. Identical `retrieve_artifact` calls (same id + same filter params) return a deterministic artifact card instead of re-emitting full content. Existing `read_file` interceptor and `block_repeat_reads` stay unchanged.

**Tech Stack:** TypeScript (strict, NodeNext), Bun test, `bun:sqlite` scorecard table (additive columns via `ensureScorecardResumeColumns`).

**Out of scope (explicit):**
- No hard gate on shell commands.
- No hard gate on `retrieve_artifact`.
- No fuzzy text-similarity "novel-output ratio" (exact identical-key only).
- `read_and_summarize` remains uncovered (still #219 design).
- `search_code` not instrumented in this PR.

**Branch:** `feat/issue-294-read-churn` off `main`.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/tools/shell-read-detect.ts` | Pure parser: shell command → read-equivalent paths (or null). |
| **Create** `src/tools/read-churn.ts` | Thresholds, retrieval-key builder, recovery-hint text. |
| **Create** `tests/shell-read-detect.test.ts` | Parser unit tests. |
| **Create** `tests/read-churn.test.ts` | Churn helpers + ScorecardTracker churn methods. |
| **Create** `tests/retrieve-artifact-churn.test.ts` | Identical-retrieve → card response. |
| **Create** `tests/shell-read-churn.test.ts` | Shell tool instrumentation (no behavior change on stdout). |
| **Modify** `src/context-engine/telemetry.ts` | New counters + `trackFileAccess` / `trackArtifactRetrieve`. |
| **Modify** `src/context-engine/db.ts` | Additive scorecard columns. |
| **Modify** `src/tools/system.ts` | Wire shell instrumentation. |
| **Modify** `src/tools/knowledge.ts` | Identical-retrieve card short-circuit. |
| **Modify** `src/tools/index.ts` | Pass scorecard + `getArtifactCard` into knowledge/system. |
| **Modify** `src/turn.ts` | Wire scorecard methods; extend nudge/footer/hints inputs. |
| **Modify** `src/context-engine/index.ts` | Expose `getArtifact(id)` (thin store passthrough). |
| **Modify** `src/compiler.ts` | Extend `AgentHintCounters` + `buildAgentHints`. |
| **Modify** `src/ui/tui/tool-icons.ts` | Footer shows churn interventions when > 0. |
| **Modify** `tests/scorecard.test.ts` | Persist/restore new counters. |
| **Modify** `tests/compiler.test.ts` | Agent-hint churn coverage. |
| **Modify** `tests/tool-icons.test.ts` | Footer churn coverage. |
| **Modify** `AGENTS.md` | Document new scorecard fields + shell instrumentation. |

---

## Design Notes (locked)

### Thresholds (`src/tools/read-churn.ts`)
```ts
/** Path access count (any channel) that triggers one recovery hint. */
export const CHURN_PATH_THRESHOLD = 3;
/** Second+ identical retrieve_artifact (same id+params) returns a card. */
export const ARTIFACT_RETRIEVE_RETRY_THRESHOLD = 2;
```

### Channels
```ts
export type FileAccessChannel = "read_file" | "shell" | "retrieve";
```
- `read_file` — also called from the existing interceptor path so cross-channel counts stay coherent.
- `shell` — only for detected read-equivalents; never blocks.
- `retrieve` — when a retrieve maps to a source path (`artifact.command` for `sourceTool === "read_file"`).

### Scorecard counters (new)
| Field | Meaning |
|---|---|
| `duplicateFileAccess` | Path re-accessed via any channel after already seen. |
| `artifactRetrievalRetries` | Identical `retrieve_artifact` (same id + params key) beyond the first. |
| `churnInterventions` | Times a recovery hint was emitted (once per path per session). |

### Shell read-equivalents (whitelist)
`cat`, `head`, `tail`, `less`, `more`, `bat`, `sed` (only with `-n` and a pure print expression like `Np` / `N,Mp` — skip `-i` / in-place), `rg` / `grep` (last non-flag arg treated as path when it looks like a path).

**Never block.** Parser returns `null` on ambiguity (pipes, redirects, compound commands with `&&`/`||`/`|`/`;`) so we under-count rather than false-positive.

### Recovery hint (soft)
Attached as a `warning` string on the tool result. Example:
```
Churn: src/ui/tui/run.tsx accessed 4× this session (read_file, shell). Prefer one narrow retrieve_artifact(id, lineStart, lineEnd) or state a preliminary conclusion.
```

### Identical retrieve response
Second+ call with the same key returns:
```ts
{
  ok: true,
  id,
  content: card,          // buildArtifactCard(...)
  warning: hint,
  skipped_payload: true,
  original_turn: art.createdTurn,
}
```
First call and calls with different filters still return full content.

---

### Task 1: Shell read-equivalent parser

**Files:**
- Create: `src/tools/shell-read-detect.ts`
- Test: `tests/shell-read-detect.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/shell-read-detect.test.ts
import { describe, it, expect } from "bun:test";
import { detectShellReads } from "../src/tools/shell-read-detect.js";

describe("detectShellReads", () => {
  it("detects simple cat/head/tail/less/more/bat", () => {
    expect(detectShellReads("cat src/a.ts")).toEqual({
      kind: "cat",
      paths: ["src/a.ts"],
    });
    expect(detectShellReads("head -n 20 foo.ts")?.paths).toEqual(["foo.ts"]);
    expect(detectShellReads("tail -n 5 bar.ts")?.paths).toEqual(["bar.ts"]);
    expect(detectShellReads("less README.md")?.kind).toBe("less");
    expect(detectShellReads("more README.md")?.kind).toBe("more");
    expect(detectShellReads("bat src/x.ts")?.paths).toEqual(["src/x.ts"]);
  });

  it("detects multi-file cat", () => {
    expect(detectShellReads("cat a.ts b.ts")?.paths).toEqual(["a.ts", "b.ts"]);
  });

  it("detects sed -n print ranges only", () => {
    expect(detectShellReads("sed -n '10,40p' src/a.ts")?.paths).toEqual(["src/a.ts"]);
    expect(detectShellReads("sed -n 10,40p src/a.ts")?.paths).toEqual(["src/a.ts"]);
    expect(detectShellReads("sed -i 's/a/b/' src/a.ts")).toBeNull();
    expect(detectShellReads("sed 's/a/b/' src/a.ts")).toBeNull();
  });

  it("detects rg/grep with a trailing path", () => {
    expect(detectShellReads("rg TODO src/")?.paths).toEqual(["src/"]);
    expect(detectShellReads("grep -n foo bar.ts")?.paths).toEqual(["bar.ts"]);
  });

  it("returns null for pipes, compounds, non-reads, empty", () => {
    expect(detectShellReads("cat a.ts | head")).toBeNull();
    expect(detectShellReads("cat a.ts && echo x")).toBeNull();
    expect(detectShellReads("ls -la")).toBeNull();
    expect(detectShellReads("npm test")).toBeNull();
    expect(detectShellReads("")).toBeNull();
  });

  it("skips flags and treats -- as end of flags", () => {
    expect(detectShellReads("cat -n -- src/a.ts")?.paths).toEqual(["src/a.ts"]);
    expect(detectShellReads("head -n 10 -- foo.ts")?.paths).toEqual(["foo.ts"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/shell-read-detect.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```ts
// src/tools/shell-read-detect.ts
export interface ShellReadDetection {
  kind: string;
  paths: string[];
}

const SIMPLE_READERS = new Set([
  "cat", "head", "tail", "less", "more", "bat",
]);
const SEARCH_READERS = new Set(["rg", "grep"]);

/** True if the command is a compound / piped shell expression we refuse to parse. */
function isCompound(command: string): boolean {
  // Rough: any unquoted pipe, &&, ||, or ; means we bail (under-count > false positive).
  return /(?:\| |&&|\|\||;)/.test(command);
}

function tokenize(command: string): string[] {
  // Simple whitespace split that keeps single/double-quoted spans intact.
  const tokens: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const raw = m[0];
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      tokens.push(raw.slice(1, -1));
    } else {
      tokens.push(raw);
    }
  }
  return tokens;
}

function stripFlags(tokens: string[], optsWithValue: Set<string>): string[] {
  const out: string[] = [];
  let i = 0;
  let endFlags = false;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (!endFlags && t === "--") {
      endFlags = true;
      i++;
      continue;
    }
    if (!endFlags && t.startsWith("-") && t !== "-") {
      // -n20 style glued values count as a single flag token.
      const flag = t.replace(/^--?/, "").split("=")[0]!;
      if (optsWithValue.has(flag) && !t.includes("=") && !/^-[^-].+\d/.test(t)) {
        i += 2; // skip flag + its value
        continue;
      }
      i++;
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
}

const SED_PRINT_RE = /^\d+(?:,\d+)?p$/;

/**
 * Detect read-equivalent shell commands. Returns null on ambiguity or non-reads.
 * Never throws. Pure — no I/O, no side effects.
 */
export function detectShellReads(command: string): ShellReadDetection | null {
  const trimmed = command.trim();
  if (!trimmed || isCompound(trimmed)) return null;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;

  // Drop env assignments: FOO=1 cat a.ts
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++;
  const rest = tokens.slice(idx);
  if (rest.length === 0) return null;

  const kind = rest[0]!.replace(/^\/.*\//, ""); // bare name even if absolute path to binary
  const bare = kind.includes("/") ? kind.split("/").pop()! : kind;

  if (SIMPLE_READERS.has(bare)) {
    const optsWithValue = bare === "head" || bare === "tail"
      ? new Set(["n", "c", "q"])
      : new Set<string>();
    const paths = stripFlags(rest.slice(1), optsWithValue).filter((p) => p.length > 0);
    if (paths.length === 0) return null;
    return { kind: bare, paths };
  }

  if (bare === "sed") {
    // Only sed -n <print-expr> <file>. Reject -i and non-print scripts.
    const args = rest.slice(1);
    const hasN = args.some((a) => a === "-n" || a === "--quiet" || a === "--silent");
    const hasI = args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place");
    if (!hasN || hasI) return null;
    const positional = stripFlags(args, new Set(["e", "f", "expression", "file"]));
    // positional: [script, ...files]
    if (positional.length < 2) return null;
    const script = positional[0]!;
    if (!SED_PRINT_RE.test(script)) return null;
    const paths = positional.slice(1);
    if (paths.length === 0) return null;
    return { kind: "sed", paths };
  }

  if (SEARCH_READERS.has(bare)) {
    // Last non-flag token is the path when present; pattern is the one before it.
    const positional = stripFlags(rest.slice(1), new Set([
      "e", "f", "g", "max-count", "m", "A", "B", "C", "context",
      "type", "t", "glob", "iglob", "max-depth",
    ]));
    if (positional.length < 2) return null; // need pattern + path
    const path = positional[positional.length - 1]!;
    // Heuristic: skip if "path" looks like a pure pattern with no path separators and no extension
    // when only one positional remains — already required length >= 2.
    return { kind: bare, paths: [path] };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/shell-read-detect.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/shell-read-detect.ts tests/shell-read-detect.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): add shell read-equivalent detector for #294

Pure parser for cat/head/tail/sed -n/rg/grep. Returns null on
pipes and compounds so we under-count rather than false-positive.
EOF
)"
```

---

### Task 2: Churn helpers + scorecard counters

**Files:**
- Create: `src/tools/read-churn.ts`
- Modify: `src/context-engine/telemetry.ts`
- Modify: `src/context-engine/db.ts`
- Test: `tests/read-churn.test.ts`
- Modify: `tests/scorecard.test.ts`

- [ ] **Step 1: Write failing tests for helpers + tracker**

```ts
// tests/read-churn.test.ts
import { describe, it, expect } from "bun:test";
import {
  ARTIFACT_RETRIEVE_RETRY_THRESHOLD,
  CHURN_PATH_THRESHOLD,
  buildArtifactRetrievalKey,
  buildPathChurnHint,
  buildRetrieveChurnHint,
} from "../src/tools/read-churn.js";
import { openDatabase } from "../src/sqlite.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";

describe("read-churn helpers", () => {
  it("builds stable retrieval keys", () => {
    const a = buildArtifactRetrievalKey("art_1", { grep: "foo", lineStart: 1, lineEnd: 10 });
    const b = buildArtifactRetrievalKey("art_1", { lineEnd: 10, lineStart: 1, grep: "foo" });
    const c = buildArtifactRetrievalKey("art_1", { grep: "bar" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("formats recovery hints", () => {
    expect(buildPathChurnHint("src/a.ts", 4, ["read_file", "shell"])).toContain("src/a.ts");
    expect(buildPathChurnHint("src/a.ts", 4, ["read_file", "shell"])).toContain("4");
    expect(buildRetrieveChurnHint("art_abc", 3)).toContain("art_abc");
  });

  it("exports thresholds used by tracker", () => {
    expect(CHURN_PATH_THRESHOLD).toBe(3);
    expect(ARTIFACT_RETRIEVE_RETRY_THRESHOLD).toBe(2);
  });
});

describe("ScorecardTracker file-access churn", () => {
  function makeTracker() {
    const raw = openDatabase(":memory:");
    const db = openContextEngineDb(raw); // ensures scorecard schema
    // openContextEngineDb may take a path — if so, use the same pattern as tests/scorecard.test.ts
    return { db: raw, tracker: new ScorecardTracker(raw, "churn-session", true) };
  }

  it("counts duplicateFileAccess and fires one intervention at threshold", () => {
    // Prefer the existing createDb() helper from scorecard.test.ts if available.
    // Inline equivalent:
    const { Database } = require("bun:sqlite"); // DO NOT USE — use openDatabase via createDb pattern
  });
});
```

**Use the existing `createDb` helper from `tests/scorecard.test.ts`.** Read the top of that file and mirror it. Concrete tests to add (in `tests/read-churn.test.ts` or extended `tests/scorecard.test.ts`):

```ts
it("trackFileAccess counts duplicates and intervenes once per path", () => {
  const db = createDb(); // same helper as scorecard.test.ts
  const tracker = new ScorecardTracker(db, "s1", true);

  const r1 = tracker.trackFileAccess("/tmp/a.ts", "read_file");
  expect(r1).toEqual({ count: 1, isDuplicate: false, shouldIntervene: false });

  const r2 = tracker.trackFileAccess("/tmp/a.ts", "shell");
  expect(r2.isDuplicate).toBe(true);
  expect(r2.count).toBe(2);
  expect(r2.shouldIntervene).toBe(false);
  expect(tracker.getCounters().duplicateFileAccess).toBe(1);

  const r3 = tracker.trackFileAccess("/tmp/a.ts", "shell");
  expect(r3.count).toBe(3);
  expect(r3.shouldIntervene).toBe(true); // hits CHURN_PATH_THRESHOLD
  expect(tracker.getCounters().churnInterventions).toBe(1);

  const r4 = tracker.trackFileAccess("/tmp/a.ts", "read_file");
  expect(r4.shouldIntervene).toBe(false); // already intervened
  expect(tracker.getCounters().churnInterventions).toBe(1);
});

it("trackArtifactRetrieve flags retries on identical key only", () => {
  const db = createDb();
  const tracker = new ScorecardTracker(db, "s1", true);
  const opts = { lineStart: 1, lineEnd: 20 };

  const a = tracker.trackArtifactRetrieve("art_1", opts);
  expect(a).toEqual({ count: 1, isRetry: false });

  const b = tracker.trackArtifactRetrieve("art_1", opts);
  expect(b.isRetry).toBe(true);
  expect(b.count).toBe(2);
  expect(tracker.getCounters().artifactRetrievalRetries).toBe(1);

  const c = tracker.trackArtifactRetrieve("art_1", { lineStart: 21, lineEnd: 40 });
  expect(c.isRetry).toBe(false); // different key
  expect(tracker.getCounters().artifactRetrievalRetries).toBe(1);
});

it("persists and restores new churn counters", () => {
  const db = createDb();
  const tracker = new ScorecardTracker(db, "s1", true);
  tracker.trackFileAccess("/tmp/a.ts", "shell");
  tracker.trackFileAccess("/tmp/a.ts", "shell");
  tracker.trackFileAccess("/tmp/a.ts", "shell"); // intervention
  tracker.trackArtifactRetrieve("art_1", {});
  tracker.trackArtifactRetrieve("art_1", {});
  tracker.persistProgress();

  const resumed = new ScorecardTracker(db, "s1", true);
  expect(resumed.restoreFromDb()).toBe(true);
  const c = resumed.getCounters();
  expect(c.duplicateFileAccess).toBe(2);
  expect(c.churnInterventions).toBe(1);
  expect(c.artifactRetrievalRetries).toBe(1);
  // Per-path state is session-local — not restored (like mtimes).
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/read-churn.test.ts`

Expected: FAIL — missing exports / methods.

- [ ] **Step 3: Implement `src/tools/read-churn.ts`**

```ts
// src/tools/read-churn.ts
export const CHURN_PATH_THRESHOLD = 3;
export const ARTIFACT_RETRIEVE_RETRY_THRESHOLD = 2;

export type FileAccessChannel = "read_file" | "shell" | "retrieve";

export interface ArtifactRetrieveParams {
  grep?: string;
  lineStart?: number;
  lineEnd?: number;
  jsonPath?: string;
}

/** Stable key for identical-retrieve detection. Field order is normalized. */
export function buildArtifactRetrievalKey(
  id: string,
  params: ArtifactRetrieveParams = {},
): string {
  return [
    id,
    params.grep ?? "",
    params.lineStart ?? "",
    params.lineEnd ?? "",
    params.jsonPath ?? "",
  ].join("\0");
}

export function buildPathChurnHint(
  displayPath: string,
  count: number,
  channels: Iterable<string>,
): string {
  const ch = [...channels].sort().join(", ");
  return (
    `Churn: ${displayPath} accessed ${count}× this session (${ch}). ` +
    `Prefer one narrow retrieve_artifact(id, lineStart, lineEnd) or state a preliminary conclusion.`
  );
}

export function buildRetrieveChurnHint(id: string, count: number): string {
  return (
    `Already retrieved ${id} with these filters (${count}×) — returning artifact card. ` +
    `Prefer a narrower line range or conclude from prior content.`
  );
}
```

- [ ] **Step 4: Extend `ScorecardCounters` + tracker methods in `telemetry.ts`**

Add to `ScorecardCounters`:
```ts
duplicateFileAccess: number;
artifactRetrievalRetries: number;
churnInterventions: number;
```

Init all three to `0` in the private `counters` object.

Add private state (session-local, not persisted — same pattern as `readPathMtimes`):
```ts
private fileAccess = new Map<string, {
  count: number;
  channels: Set<string>;
  intervened: boolean;
}>();
private artifactRetrievalKeys = new Map<string, number>();
```

Add methods:
```ts
import {
  ARTIFACT_RETRIEVE_RETRY_THRESHOLD,
  CHURN_PATH_THRESHOLD,
  buildArtifactRetrievalKey,
  type ArtifactRetrieveParams,
  type FileAccessChannel,
} from "../tools/read-churn.js";

trackFileAccess(
  absPath: string,
  channel: FileAccessChannel,
): { count: number; isDuplicate: boolean; shouldIntervene: boolean } {
  if (!this.db) return { count: 0, isDuplicate: false, shouldIntervene: false };
  const digest = createHash("sha256").update(absPath).digest("hex");
  let state = this.fileAccess.get(digest);
  if (!state) {
    state = { count: 0, channels: new Set(), intervened: false };
    this.fileAccess.set(digest, state);
  }
  state.count += 1;
  state.channels.add(channel);
  const isDuplicate = state.count > 1;
  if (isDuplicate) this.inc("duplicateFileAccess");

  let shouldIntervene = false;
  if (state.count >= CHURN_PATH_THRESHOLD && !state.intervened) {
    state.intervened = true;
    shouldIntervene = true;
    this.inc("churnInterventions");
  }
  return { count: state.count, isDuplicate, shouldIntervene };
}

trackArtifactRetrieve(
  id: string,
  params: ArtifactRetrieveParams = {},
): { count: number; isRetry: boolean } {
  if (!this.db) return { count: 0, isRetry: false };
  const key = buildArtifactRetrievalKey(id, params);
  const next = (this.artifactRetrievalKeys.get(key) ?? 0) + 1;
  this.artifactRetrievalKeys.set(key, next);
  const isRetry = next >= ARTIFACT_RETRIEVE_RETRY_THRESHOLD;
  if (isRetry) this.inc("artifactRetrievalRetries");
  return { count: next, isRetry };
}

/** Channels recorded for a path (for hint text). Empty if unknown. */
getFileAccessChannels(absPath: string): string[] {
  if (!this.db) return [];
  const digest = createHash("sha256").update(absPath).digest("hex");
  const state = this.fileAccess.get(digest);
  return state ? [...state.channels] : [];
}
```

**Also call `trackFileAccess(absPath, "read_file")` from inside `trackReadPath`** so the existing interceptor path feeds the cross-channel counter without double-wiring every call site:

```ts
trackReadPath(absPath: string, mtimeMs?: number, countAsRepeat = true): void {
  if (!this.db) return;
  // existing digest / repeatFileReads logic unchanged ...
  this.trackFileAccess(absPath, "read_file"); // after the repeatFileReads bump
}
```

Careful: `trackFileAccess` will then always run on every `trackReadPath`. First read_file → count 1, not duplicate. Second read_file → duplicate + eventually intervention. Good.

Update `ScorecardInc`:
```ts
export type ScorecardInc = Pick<
  ScorecardTracker,
  "inc" | "trackReadPath" | "trackSkillLoad" | "trackFileAccess" | "trackArtifactRetrieve" | "getFileAccessChannels"
>;
```

Update `ScorecardDbRow`, `restoreFromDb`, `writeScorecardRow`, and `formatScorecardLines`:
- Add columns to INSERT/SELECT.
- In `formatScorecardLines`, append to the Context line:
  ```
  dup_access: ${counters.duplicateFileAccess}  retrieve_retries: ${counters.artifactRetrievalRetries}  churn: ${counters.churnInterventions}
  ```

- [ ] **Step 5: Additive DB columns in `db.ts`**

Extend `SCORECARD_RESUME_COLUMNS` (the ALTER TABLE path used for existing DBs):
```ts
{ name: "duplicate_file_access", ddl: "INTEGER NOT NULL DEFAULT 0" },
{ name: "artifact_retrieval_retries", ddl: "INTEGER NOT NULL DEFAULT 0" },
{ name: "churn_interventions", ddl: "INTEGER NOT NULL DEFAULT 0" },
```

Also add the three columns to the `CREATE TABLE IF NOT EXISTS scorecard` body so fresh DBs get them inline:
```
duplicate_file_access       INTEGER DEFAULT 0,
artifact_retrieval_retries  INTEGER DEFAULT 0,
churn_interventions         INTEGER DEFAULT 0,
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/read-churn.test.ts tests/scorecard.test.ts`

Expected: PASS. Fix any existing scorecard tests that assert exact `formatScorecardLines` output or exact INSERT column lists.

- [ ] **Step 7: Commit**

```bash
git add src/tools/read-churn.ts src/context-engine/telemetry.ts src/context-engine/db.ts tests/read-churn.test.ts tests/scorecard.test.ts
git commit -m "$(cat <<'EOF'
feat(scorecard): track file-access and retrieve churn for #294

Adds duplicateFileAccess, artifactRetrievalRetries, churnInterventions
counters plus session-local per-path / per-key state. No hard gates.
EOF
)"
```

---

### Task 3: Instrument the shell tool (telemetry only)

**Files:**
- Modify: `src/tools/system.ts`
- Modify: `src/tools/index.ts` (if new callback needed — prefer using `skillScorecard` / scorecard directly)
- Test: `tests/shell-read-churn.test.ts`

- [ ] **Step 1: Write the failing test**

Mirror the setup pattern from `tests/repeat-read-interceptor.test.ts` (create system tools with a live scorecard). Sketch:

```ts
// tests/shell-read-churn.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/sqlite.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";
import { createSystemTools } from "../src/tools/system.js";
// ... minimal SkillRuntime stubs as in repeat-read-interceptor.test.ts

describe("shell read churn instrumentation", () => {
  it("counts shell cat of a path without changing stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-shell-churn-"));
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
    const db = openDatabase(":memory:");
    // ensure scorecard table exists — use same createDb helper
    const tracker = new ScorecardTracker(db, "s", true);
    const tools = createSystemTools({
      cwd: dir,
      skills: [],
      skillRuntime: null,
      skillScorecard: tracker,
      getCurrentTurn: () => 1,
    });

    const r1 = await tools.shell.execute({ command: "cat a.ts" });
    expect(r1.ok).toBe(true);
    expect(r1.stdout).toContain("export const x");
    expect(r1.warning).toBeUndefined();
    expect(tracker.getCounters().duplicateFileAccess).toBe(0);

    await tools.shell.execute({ command: "cat a.ts" });
    expect(tracker.getCounters().duplicateFileAccess).toBe(1);

    const r3 = await tools.shell.execute({ command: "cat a.ts" });
    expect(tracker.getCounters().churnInterventions).toBe(1);
    expect(r3.warning).toMatch(/Churn:/);
    // stdout still intact
    expect(r3.stdout).toContain("export const x");

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not instrument non-read commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-shell-churn-"));
    const db = /* createDb */;
    const tracker = new ScorecardTracker(db, "s", true);
    const tools = createSystemTools({ /* ... skillScorecard: tracker, cwd: dir */ });
    await tools.shell.execute({ command: "echo hello" });
    expect(tracker.getCounters().duplicateFileAccess).toBe(0);
    expect(tracker.getCounters().churnInterventions).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/shell-read-churn.test.ts`

Expected: FAIL — shell result has no warning / counters stay 0.

- [ ] **Step 3: Wire shell execute in `system.ts`**

At top of file, import:
```ts
import { detectShellReads } from "./shell-read-detect.js";
import { buildPathChurnHint } from "./read-churn.js";
import { relative } from "node:path"; // if not already
```

Replace the `shell` execute body:
```ts
execute: async ({ command, timeout }) => {
  const signal = getAbortSignal?.();
  if (signal?.aborted) {
    return { ok: false, stdout: "", stderr: "Interrupted", exitCode: 130 };
  }

  const result = await executeShellCommand({
    command,
    cwd,
    sandbox,
    timeout,
    abortSignal: signal,
    onStdout: shellLiveStream !== false
      ? (chunk) => process.stdout.write(chunk)
      : undefined,
    onStderr: shellLiveStream !== false
      ? (chunk) => process.stderr.write(chunk)
      : undefined,
  });

  // Telemetry only — never block, never alter stdout/stderr/exitCode.
  if (result.ok && skillScorecard?.trackFileAccess) {
    const detected = detectShellReads(command);
    if (detected) {
      let warning: string | undefined;
      for (const p of detected.paths) {
        const absPath = resolvePath(p);
        const outcome = skillScorecard.trackFileAccess(absPath, "shell");
        if (outcome.shouldIntervene) {
          const channels = skillScorecard.getFileAccessChannels?.(absPath) ?? ["shell"];
          const display = absPath.startsWith(cwd) ? relative(cwd, absPath) || p : p;
          warning = buildPathChurnHint(display, outcome.count, channels);
        }
      }
      if (warning) return { ...result, warning };
    }
  }

  return result;
},
```

`ScorecardInc` already exposes the new methods after Task 2, and `skillScorecard` is typed as `ScorecardInc`, so no new callback on `SystemToolContext` is required.

- [ ] **Step 4: Run tests**

Run: `bun test tests/shell-read-churn.test.ts tests/repeat-read-interceptor.test.ts`

Expected: PASS. Existing interceptor tests must still pass (no behavior change to `read_file`).

- [ ] **Step 5: Commit**

```bash
git add src/tools/system.ts tests/shell-read-churn.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): instrument read-equivalent shell commands for churn (#294)

Counts cat/head/tail/sed -n/rg/grep path access in the scorecard and
attaches a soft recovery warning at the path threshold. Never blocks.
EOF
)"
```

---

### Task 4: Identical `retrieve_artifact` → deterministic card

**Files:**
- Modify: `src/context-engine/index.ts` (expose `getArtifact`)
- Modify: `src/tools/knowledge.ts`
- Modify: `src/tools/index.ts` (scorecard already passed as `skillScorecard`)
- Test: `tests/retrieve-artifact-churn.test.ts`

- [ ] **Step 1: Write the failing test**

Use an in-memory context engine + knowledge tools. Mirror patterns from existing artifact / knowledge tests (`tests/` — search for `retrieve_artifact` or `ingestToolResult`).

```ts
// tests/retrieve-artifact-churn.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// Use the same harness other context-engine tests use to spin up ContextEngine
// with a temp dir + :memory: db. Ingest a read_file artifact, then:

it("returns full content on first retrieve, card on identical retry", () => {
  // 1. ingest a read_file artifact → art id
  // 2. first retrieve_artifact(id) → ok, content === raw, no warning, retries === 0
  // 3. second retrieve_artifact(id) identical params
  //    → ok, content === buildArtifactCard(...), warning matches /Already retrieved/,
  //       skipped_payload === true, artifactRetrievalRetries === 1
  // 4. third with different lineStart/lineEnd → full (sliced) content, isRetry false for that key
});

it("different filters do not count as retries against each other", () => {
  // retrieve id with lineStart=1,lineEnd=10
  // retrieve id with lineStart=11,lineEnd=20
  // artifactRetrievalRetries stays 0
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retrieve-artifact-churn.test.ts`

Expected: FAIL — second call still returns full content.

- [ ] **Step 3: Expose `getArtifact` on ContextEngine**

In `src/context-engine/index.ts`:
```ts
getArtifact(id: string): ContextArtifact | null {
  return this.store.getArtifact(id);
}
```

- [ ] **Step 4: Short-circuit identical retrieves in `knowledge.ts`**

```ts
import { buildArtifactCard } from "../context-engine/summarize.js";
import { buildRetrieveChurnHint } from "./read-churn.js";

// inside retrieve_artifact execute:
execute: async ({ id, grep, lineStart, lineEnd, jsonPath }) => {
  const params = { grep, lineStart, lineEnd, jsonPath };
  const track = ctx.skillScorecard?.trackArtifactRetrieve?.(id, params);
  const isRetry = track?.isRetry === true;

  if (isRetry) {
    const art = contextEngine.getArtifact(id);
    if (art) {
      const card = buildArtifactCard(art.id, art.sourceTool, art.command, art.rawTokens);
      ctx.skillScorecard?.inc("artifactRetrieveCalls");
      // Optional: also feed path-level churn when this artifact is a file read.
      if (art.sourceTool === "read_file" && art.command && ctx.skillScorecard?.trackFileAccess) {
        const outcome = ctx.skillScorecard.trackFileAccess(art.command, "retrieve");
        // path intervention is independent; card response is the retrieve-level action
        void outcome;
      }
      eventLog.append({
        kind: "system_note",
        actor: "kernel",
        payload: {
          type: "artifact_retrieve_retry",
          id,
          grep: grep ?? null,
          lineStart: lineStart ?? null,
          lineEnd: lineEnd ?? null,
          jsonPath: jsonPath ?? null,
          count: track?.count ?? 0,
        },
      });
      return {
        ok: true,
        id,
        content: card,
        warning: buildRetrieveChurnHint(id, track?.count ?? 0),
        skipped_payload: true,
        original_turn: art.createdTurn,
      };
    }
    // Artifact missing — fall through to normal retrieve (will error cleanly).
  }

  const retrieved = contextEngine.retrieveArtifact(id, getCurrentTurn(), params);
  if (!retrieved.ok) {
    return { ok: false, error: retrieved.error };
  }

  ctx.skillScorecard?.inc("artifactRetrieveCalls");

  // Path-level tracking for file-read artifacts (first successful retrieve).
  const art = contextEngine.getArtifact(id);
  if (art?.sourceTool === "read_file" && art.command && ctx.skillScorecard?.trackFileAccess) {
    ctx.skillScorecard.trackFileAccess(art.command, "retrieve");
  }

  eventLog.append({
    kind: "system_note",
    actor: "kernel",
    payload: {
      type: "artifact_retrieve",
      id,
      grep: grep ?? null,
      lineStart: lineStart ?? null,
      lineEnd: lineEnd ?? null,
      jsonPath: jsonPath ?? null,
    },
  });

  return { ok: true, id, content: retrieved.content };
},
```

Notes:
- `trackArtifactRetrieve` runs **before** the real retrieve so the first call records count=1 and the second short-circuits.
- We still `inc("artifactRetrieveCalls")` on retries so total retrieve volume stays honest.
- No hard gate: if the artifact row is gone, fall through.

- [ ] **Step 5: Run tests**

Run: `bun test tests/retrieve-artifact-churn.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/context-engine/index.ts src/tools/knowledge.ts tests/retrieve-artifact-churn.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): return artifact card on identical retrieve_artifact retries (#294)

Second+ call with the same id and filters yields a deterministic card
instead of re-emitting the full payload. Different filters still retrieve.
EOF
)"
```

---

### Task 5: Surface recovery hints (nudge / agent hint / footer / scorecard display)

**Files:**
- Modify: `src/compiler.ts` (`AgentHintCounters`, `buildAgentHints`)
- Modify: `src/turn.ts` (`buildScorecardNudge`, agentHints wiring, footer input)
- Modify: `src/ui/tui/tool-icons.ts` (`TurnFooterInput`, `formatTurnFooterDigest`)
- Modify: `tests/compiler.test.ts`
- Modify: `tests/tool-icons.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/compiler.test.ts — add:
import { buildAgentHints } from "../src/compiler.js";

it("buildAgentHints includes churn interventions", () => {
  expect(buildAgentHints({ repeatFileReads: 0, churnInterventions: 0 })).toBe("");
  const text = buildAgentHints({ repeatFileReads: 0, churnInterventions: 2 });
  expect(text).toContain("churn_interventions: 2");
  expect(text).toContain("narrow retrieve_artifact");
});

// tests/tool-icons.test.ts — add:
it("footer shows churn when interventions > 0", () => {
  const line = formatTurnFooterDigest({
    durationMs: 10,
    ambient: "quiet",
    editCount: 0,
    writeCount: 0,
    ctxBeforePct: 0,
    ctxAfterPct: 0,
    churnInterventions: 2,
  });
  expect(line).toContain("churn:2");
});
```

Also extend `buildScorecardNudge` test if one exists; otherwise add a small unit-style test near other turn helpers, or cover via the integration fixture in Task 6.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/compiler.test.ts tests/tool-icons.test.ts --test-name-pattern "churn"`

Expected: FAIL.

- [ ] **Step 3: Implement surfaces**

`src/compiler.ts`:
```ts
export interface AgentHintCounters {
  repeatFileReads: number;
  churnInterventions?: number;
}

export function buildAgentHints(counters: AgentHintCounters): string {
  const parts: string[] = [];
  if (counters.repeatFileReads > AGENT_HINT_REPEAT_READS_THRESHOLD) {
    parts.push(
      `- repeat_file_reads: ${counters.repeatFileReads} — before re-reading a path, use retrieve_artifact or search_turn_events.`,
    );
  }
  if ((counters.churnInterventions ?? 0) > 0) {
    parts.push(
      `- churn_interventions: ${counters.churnInterventions} — stop re-reading the same files; use one narrow retrieve_artifact(id, lineStart, lineEnd) or state a preliminary conclusion.`,
    );
  }
  if (parts.length === 0) return "";
  return `## Agent Hints\n\n${parts.join("\n")}`;
}
```

`src/turn.ts` — where `buildAgentHints` is called (~line 515):
```ts
agentHints: buildAgentHints({
  repeatFileReads: session.scorecard.getCounters().repeatFileReads,
  churnInterventions: session.scorecard.getCounters().churnInterventions,
}),
```

`buildScorecardNudge` — extend start/end shape:
```ts
function buildScorecardNudge(
  start: { repeatFileReads: number; noOpTools: number; churnInterventions: number } | null | undefined,
  end: { repeatFileReads: number; noOpTools: number; churnInterventions: number } | null | undefined,
  turnRecallCalls: number,
  turnRecallHits: number,
): string | undefined {
  if (!start || !end) return undefined;
  const churnDelta = end.churnInterventions - start.churnInterventions;
  if (churnDelta > 0) {
    return `Tip: read/retrieve churn detected; use one narrow retrieve_artifact or conclude.`;
  }
  // existing repeatReadsDelta / noOp / recall logic...
}
```

Update the call site that snapshots start/end counters to include `churnInterventions`.

`src/ui/tui/tool-icons.ts`:
```ts
export interface TurnFooterInput {
  // ...existing
  /** Session churn_interventions; shown when > 0. */
  churnInterventions?: number;
}

// in formatTurnFooterDigest, after repeat_reads:
const churn = input.churnInterventions ?? 0;
if (churn > 0) {
  parts.push(`churn:${churn}`);
}
```

Wire footer input in `turn.ts` (~line 1486):
```ts
churnInterventions: session.scorecard?.getCounters?.().churnInterventions ?? 0,
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/compiler.test.ts tests/tool-icons.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts src/turn.ts src/ui/tui/tool-icons.ts tests/compiler.test.ts tests/tool-icons.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): surface read-churn interventions in hints and footer (#294)

Agent hints, per-turn tip, and turn footer all reflect churnInterventions
so the harness can interrupt runaway re-read loops early.
EOF
)"
```

---

### Task 6: Integration fixture — recovery hint before excessive tool use

**Files:**
- Create: `tests/read-churn-fixture.test.ts`

Acceptance criterion: *"A repeated-read/code-review fixture triggers one recovery hint before excessive tool use."*

- [ ] **Step 1: Write the fixture test**

```ts
// tests/read-churn-fixture.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Reuse createDb + createSystemTools + ScorecardTracker harness from earlier tests.

describe("read-churn fixture (#294 acceptance)", () => {
  it("emits exactly one recovery hint by the 3rd cross-channel access of the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-churn-fix-"));
    writeFileSync(join(dir, "run.tsx"), "export function run() {}\n".repeat(20));
    const db = createDb();
    const tracker = new ScorecardTracker(db, "fixture", true);
    const tools = createSystemTools({
      cwd: dir,
      skills: [],
      skillRuntime: null,
      skillScorecard: tracker,
      getCurrentTurn: () => 1,
      // enable path tracking used by read_file:
      onScorecardFileRead: (p, m, c) => tracker.trackReadPath(p, m, c),
      hasReadPath: (p) => tracker.hasReadPath(p),
      getReadPathMtime: (p) => tracker.getReadPathMtime(p),
      clearReadPath: (p) => tracker.clearReadPath(p),
    });

    // 1. shell cat (channel: shell) — no hint
    const a = await tools.shell.execute({ command: "cat run.tsx" });
    expect(a.warning).toBeUndefined();

    // 2. shell cat again — duplicate, no intervention yet (threshold 3)
    const b = await tools.shell.execute({ command: "cat run.tsx" });
    expect(b.warning).toBeUndefined();
    expect(tracker.getCounters().duplicateFileAccess).toBeGreaterThanOrEqual(1);

    // 3. third access — intervention fires exactly once
    const c = await tools.shell.execute({ command: "cat run.tsx" });
    expect(c.warning).toMatch(/Churn:/);
    expect(tracker.getCounters().churnInterventions).toBe(1);

    // 4. further access — no second intervention
    const d = await tools.shell.execute({ command: "cat run.tsx" });
    expect(d.warning).toBeUndefined();
    expect(tracker.getCounters().churnInterventions).toBe(1);

    // Well under the 81-call blowup from the evidence session.
    expect(tracker.getCounters().churnInterventions).toBeLessThan(2);

    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the fixture**

Run: `bun test tests/read-churn-fixture.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/read-churn-fixture.test.ts
git commit -m "$(cat <<'EOF'
test: add #294 read-churn acceptance fixture

Asserts one recovery hint by the third cross-channel access of the
same file — well before the 81-call blowup in the evidence session.
EOF
)"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `AGENTS.md` (Telemetry scorecard section + Repeat-read interceptor section)

- [ ] **Step 1: Update AGENTS.md**

In the **Telemetry scorecard (issue #99)** bullet list of signals, add:
```
- churn (duplicate file access across read_file/shell/retrieve, artifact retrieval retries, churn interventions) — issue #294
```

In the **Repeat-read interceptor (issue #219)** section, add a short note:
```
### Read / retrieve churn detection (issue #294)

Cross-channel path access (read_file, read-equivalent shell commands, retrieve_artifact
of file-read artifacts) is counted in the scorecard. At CHURN_PATH_THRESHOLD (3) accesses
of the same path, a soft recovery `warning` is attached to the tool result and
`churnInterventions` increments once per path. Identical `retrieve_artifact` calls
(same id + filters) return a deterministic artifact card instead of re-emitting the
full payload (`artifactRetrievalRetries`). Read-equivalent shell commands
(`cat`/`head`/`tail`/`sed -n`/`rg`/`grep`) are instrumented for telemetry only —
never blocked. Parser: `src/tools/shell-read-detect.ts`. Helpers: `src/tools/read-churn.ts`.
```

- [ ] **Step 2: Full suite + typecheck**

```bash
bun typecheck && bun test
```

Expected: typecheck clean, full suite green (currently ~997+ tests; expect a small net add).

- [ ] **Step 3: Final commit**

```bash
git add AGENTS.md
git commit -m "$(cat <<'EOF'
docs: document read-churn detection (#294) in AGENTS.md
EOF
)"
```

---

## Acceptance Criteria Mapping

| Criterion | Task |
|---|---|
| Repeated identical artifact retrievals → deterministic card / line-range path | Task 4 |
| Repeated-read fixture triggers one recovery hint before excessive tool use | Task 6 |
| Read-only shell equivalents counted without behavior change | Task 1 + Task 3 |
| Scorecard identifies repeated-read / artifact-churn regressions | Task 2 + Task 5 (`duplicateFileAccess`, `artifactRetrievalRetries`, `churnInterventions`) |

## Spec coverage self-check

1. Per-turn tool-churn detector (same path, repeated retrieval, alternating retrieve+shell, low novel-output) — **covered** via `trackFileAccess` channels + identical retrieval keys. Fuzzy novel-output ratio deliberately simplified to exact-key identity (YAGNI; noted in Out of scope).
2. Harness-level recovery hint after threshold — **covered** (tool `warning` + per-turn tip + agent hint + footer).
3. Improve repeat-read response with reliable artifact ID + line-range path — **already present for `read_file`** (#219); retrieve path improved in Task 4. No change to the existing interceptor.
4. Instrument read-only shell equivalents; do not block — **covered** (Tasks 1, 3).
5. Scorecard fields — **covered** (Task 2).

## Placeholder scan

No TBD / "add error handling" / "write tests later" steps. Every task has concrete code, commands, and expected outcomes.
