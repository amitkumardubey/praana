import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecretsStrict } from "../redact/secrets.js";
import { parseMemory, searchTokens, serializeMemory, validName, validateMemory, validateQueryPolicy, type Memory, type MemoryInput } from "./format.js";
import { globalMemoryDirectory, memoryDirectories, projectKey, type MemoryScope } from "./paths.js";
import { buildMemoryIndex as renderMemoryIndex, type MemoryIndex } from "./index.js";
import { rankMemories, type RecallMatch, type ScopedMemory } from "./recall.js";
export { MEMORY_POLICY } from "./index.js";

export interface StoreOptions {
  home: string;
  cwd: string;
  now?: () => Date;
  fs?: typeof nodeFs;
  incognito?: boolean;
  findRoot?: (cwd: string) => string;
}
type SkippedScope = { scope: MemoryScope; reason: string };
type ScopeWarnings = { skippedScopes?: SkippedScope[] };
type ResultError = { ok: false; error: string; similar?: Array<{ name: string; description: string }> } & ScopeWarnings;
/** Incognito blocks every mutation; each operation names the action it could not perform. */
const INCOGNITO_PREFIX = "Incognito mode prevents";
const incognitoRefusal = (blocked: "writes" | "removal"): ResultError => ({ ok: false, error: `${INCOGNITO_PREFIX} ${blocked}` });
const scopeWarnings = (skippedScopes: SkippedScope[]): ScopeWarnings => skippedScopes.length ? { skippedScopes } : {};
const reasonText = (skippedScopes: SkippedScope[]) => skippedScopes.map(({ scope, reason }) => `${scope}: ${reason}`).join("; ");
/** Every unscoped by-name operation refuses through here, so `read`, `recall` and
 * `remove` share one message shape and one precedence rule. */
function refuseUnlessExplicit(
  unscoped: boolean,
  skippedScopes: SkippedScope[] | undefined,
  rule: "answer" | "removal",
  advice: (reasons: string) => string,
): ResultError | undefined {
  if (!unscoped) return undefined;
  const skipped = skippedScopes ?? [];
  const blocking = blockingScopes(skipped, rule);
  const failed = skipped.filter(({ scope }) => blocking.includes(scope));
  return failed.length ? { ok: false, error: advice(reasonText(failed)), ...scopeWarnings(skipped) } : undefined;
}
type ListEntry = Omit<Memory, "body"> & { scope: MemoryScope; age: number; stale: boolean };
/** Precedence order: the first scope that holds the name answers an unscoped by-name lookup,
 * so only a failed scan ahead of the first clean one can still change that answer, while a
 * removal must rule out every scope. Both blocking sets derive from this one order. */
const scopes: MemoryScope[] = ["project", "global"];
const blockingScopes = (skippedScopes: SkippedScope[], rule: "answer" | "removal"): MemoryScope[] => {
  if (rule === "removal") return scopes;
  const failed = new Set(skippedScopes.map(({ scope }) => scope));
  const clean = scopes.findIndex((scope) => !failed.has(scope));
  return clean < 0 ? scopes : scopes.slice(0, clean);
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
/** Path-free cause class for a single unreadable memory file. */
const readCause = (error: unknown): string => {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "EACCES": case "EPERM": return "permission denied";
    case "EIO": return "input/output error";
    case "EISDIR": return "not a regular file";
    case "EMFILE": case "ENFILE": return "too many open files";
    default: { const code = (error as NodeJS.ErrnoException)?.code; return code ? `read failed (${code})` : "read failed"; }
  }
};
const errorResult = (error: unknown): ResultError => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
const inside = (parent: string, child: string) => { const p = relative(parent, child); return p === "" || (!p.startsWith(`..${sep}`) && p !== ".." && !isAbsolute(p)); };
/** Description tokens are compared as a Jaccard overlap of searchTokens. Below three
 * tokens on either side the ratio is too coarse to mean anything, and two four-token
 * descriptions that differ by one word score exactly 0.6, so the bar is 0.75. */
const DUPLICATE_MIN_TOKENS = 3;
const DUPLICATE_JACCARD = 0.75;

/** Atomic replacement is last-writer-wins. Duplicate and created results are advisory under races.
 * Orphan temp files are ignored, not collected. Hand-edited files are not secret-scanned. */
export function createFileMemoryStore(options: StoreOptions) {
  const fs = options.fs ?? nodeFs;
  const home = resolve(options.home);
  const globalDirectory = globalMemoryDirectory(home);
  // Only the project scope depends on resolving a root; global memory must survive that failure.
  let projectDirectory: string | undefined;
  let rootError: ResultError | undefined;
  try { projectDirectory = memoryDirectories(home, projectKey(options.cwd, options.findRoot)).project; }
  catch (error) { rootError = errorResult(error); }
  const now = options.now ?? (() => new Date());

  async function directory(scope: MemoryScope, create: boolean): Promise<string | null> {
    if (!scopes.includes(scope)) throw new Error("Invalid scope");
    const target = scope === "global" ? globalDirectory : projectDirectory;
    if (!target) throw new Error(rootError?.error ?? "Project root unavailable");
    // The user controls .praana and its ancestors; only descendants are untrusted.
    const base = join(home, ".praana");
    let root: string;
    try { root = await fs.realpath(base); } catch (error) {
      if (!missing(error)) throw error;
      let entry;
      try { entry = await fs.lstat(base); }
      catch (entryError) { if (!missing(entryError)) throw entryError; }
      // realpath missed, but lstat still sees a dangling link: never create its target.
      if (entry?.isSymbolicLink()) throw new Error(`Dangling .praana symlink: ${base}`);
      if (!create) return null;
      await fs.mkdir(base, { mode: 0o700, recursive: true });
      root = await fs.realpath(base);
    }
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Unsafe .praana root");
    const path = join(root, relative(base, target));
    let current = root;
    for (const part of relative(root, path).split(sep)) {
      current = join(current, part);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return null;
        try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe memory directory: ${current}`);
      if (!inside(root, await fs.realpath(current))) throw new Error("Memory directory escapes .praana root");
    }
    return path;
  }

  /** One file that cannot be read is reported, never thrown: a single bad file must not
   * take out its whole scope. `failure` is path-free so it can reach a result message. */
  async function readFile(dir: string, name: string, frontmatterOnly = false): Promise<{ memory: Memory | null; failure?: string }> {
    const path = join(dir, `${name}.md`);
    let handle: nodeFs.FileHandle | undefined;
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return { memory: null };
      handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size > 65536) return { memory: null };
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const size = frontmatterOnly ? Math.min(1024, buffer.length - length) : buffer.length - length;
        const { bytesRead } = await handle.read(buffer, length, size, length);
        if (!bytesRead) break;
        length += bytesRead;
        if (frontmatterOnly) {
          const header = buffer.subarray(0, length).toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
          const closing = (length >= actual.size ? /\n---(?:\n|$)/ : /\n---\n/).exec(header.slice(4));
          if (closing) {
            const memory = parseMemory(header.slice(0, closing.index + 4 + closing[0].length));
            return { memory: memory?.name === name ? memory : null };
          }
          // Raw CRLF frontmatter can be up to twice the normalized byte bound.
          if (length > 16390) return { memory: null };
        }
      }
      if (length > 65536) return { memory: null };
      const memory = parseMemory(buffer.subarray(0, length).toString("utf8"));
      return { memory: memory?.name === name ? memory : null };
    } catch (error) {
      // Absent and looping paths are an ordinary miss; anything else is a per-file skip.
      if (missing(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return { memory: null };
      return { memory: null, failure: `Memory "${name}" is unreadable: ${readCause(error)}` };
    } finally { if (handle) await handle.close(); }
  }

  async function entries(scope: MemoryScope, frontmatterOnly = false): Promise<{ memories: Memory[]; skipped: number; filenames: string[] }> {
    const dir = await directory(scope, false);
    if (!dir) return { memories: [], skipped: 0, filenames: [] };
    let filenames: string[];
    try { filenames = await fs.readdir(dir); } catch (error) { if (missing(error)) return { memories: [], skipped: 0, filenames: [] }; throw error; }
    const memories: Memory[] = [];
    let skipped = 0;
    for (const file of filenames) {
      if (file.startsWith(".") || file === "MEMORY.md" || !file.endsWith(".md")) continue;
      const name = file.slice(0, -3);
      if (!validName(name)) { skipped++; continue; }
      const { memory } = await readFile(dir, name, frontmatterOnly);
      if (memory) memories.push(memory); else skipped++;
    }
    return { memories, skipped, filenames };
  }

  async function visitScopes<T>(requested: MemoryScope | undefined, visit: (scope: MemoryScope) => Promise<T>) {
    const values: T[] = [];
    const skippedScopes: SkippedScope[] = [];
    for (const scope of requested ? [requested] : scopes) {
      try { values.push(await visit(scope)); }
      catch (error) { skippedScopes.push({ scope, reason: errorResult(error).error }); }
    }
    if (!values.length) return { ok: false as const, error: reasonText(skippedScopes), skippedScopes };
    return { ok: true as const, values, ...scopeWarnings(skippedScopes) };
  }

  // Strip only generic affixes; identical descriptions are always duplicates, and a
  // Jaccard overlap of searchTokens needs three tokens on both sides and 0.75.
  function similar(a: MemoryInput, b: Memory): boolean {
    const normalize = (s: string) => s.replace(/(?:^|-)(?:the|a|an|note|memory)(?=-|$)/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (normalize(a.name) && normalize(a.name) === normalize(b.name)) return true;
    // Unicode-aware and stop-word free, so short and CJK descriptions are comparable.
    const collapse = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
    if (collapse(a.description) === collapse(b.description)) return true;
    const x = new Set(searchTokens(a.description)), y = new Set(searchTokens(b.description));
    if (x.size < DUPLICATE_MIN_TOKENS || y.size < DUPLICATE_MIN_TOKENS) return false;
    const union = new Set([...x, ...y]);
    return [...x].filter((token) => y.has(token)).length / union.size >= DUPLICATE_JACCARD;
  }

  async function atomicReplace(dir: string, filename: string, text: string): Promise<void> {
    const target = join(dir, filename);
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Symlink memory file refused"); } catch (error) { if (!missing(error)) throw error; }
    const temp = join(dir, `.${filename}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
    let createdTemp = false;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      createdTemp = true;
      try { await handle.writeFile(text, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, target);
      createdTemp = false;
      try { const handle = await fs.open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch { /* Directory fsync is best-effort. */ }
    } finally { if (createdTemp) { try { await fs.unlink(temp); } catch (error) { if (!missing(error)) throw error; } } }
  }

  async function write(input: MemoryInput & { scope: MemoryScope }): Promise<{ ok: true; name: string; scope: MemoryScope; created: boolean } | ResultError> {
    if (options.incognito) return incognitoRefusal("writes");
    try {
      const allowed = new Set(["scope", "type", "name", "description", "body"]);
      if (!input || typeof input !== "object" || Reflect.ownKeys(input).some((key) => !allowed.has(String(key)))) return { ok: false, error: "Unknown write input key; allowed keys: scope, type, name, description, body" };
      const invalid = validateMemory(input);
      if (invalid) return { ok: false, error: invalid };
      if (!scopes.includes(input.scope)) return { ok: false, error: "Invalid scope" };
      // Scan each string field by property, so the input's prototype is irrelevant and a
      // strict-mode throw becomes a refusal instead of an exception out of write.
      const secretFields: string[] = [];
      for (const field of ["name", "description", "body"] as const) {
        let scanned: string;
        try { scanned = redactSecretsStrict(input[field]); } catch { return { ok: false, error: "Secret scan failed" }; }
        if (scanned !== input[field]) secretFields.push(field);
      }
      if (secretFields.length) return { ok: false, error: `Secret-shaped content refused in ${secretFields.join(", ")}. Remove the secret-shaped text before retrying` };
      const existingDir = await directory(input.scope, false);
      let filenames: string[] = [];
      if (existingDir) {
        try { filenames = await fs.readdir(existingDir); } catch (error) { if (!missing(error)) throw error; }
      }
      const targetName = `${input.name}.md`;
      const exists = filenames.includes(targetName);
      if (!exists) {
        const existing = await entries(input.scope);
        const matches = existing.memories.filter((entry) => entry.name !== input.name && similar(input, entry)).map(({ name, description }) => ({ name, description }));
        if (matches.length) return { ok: false, error: "Similar memory exists; update it instead", similar: matches };
      }
      if (filenames.some((file) => file.toLowerCase() === targetName.toLowerCase() && file !== targetName)) return { ok: false, error: "Case-insensitive filename collision" };
      const dir = await directory(input.scope, true);
      if (!dir) throw new Error("Memory directory unavailable");
      await atomicReplace(dir, targetName, serializeMemory({ ...input, updated: now().toISOString().slice(0, 10) }));
      // The authoritative file is committed; refresh reports its own best-effort error.
      await refreshIndexFile(input.scope);
      return { ok: true, name: input.name, scope: input.scope, created: !exists };
    } catch (error) { return errorResult(error); }
  }

  async function read(input: { scope?: MemoryScope; name: string }): Promise<({ ok: true; memory: Memory & { scope: MemoryScope } } & ScopeWarnings) | ResultError> {
    if (!validName(input.name)) return { ok: false, error: "Invalid memory name" };
    const scanned = await visitScopes(input.scope, async (scope) => {
      const dir = await directory(scope, false);
      if (!dir) return { scope, memory: null };
      const { memory, failure } = await readFile(dir, input.name);
      return { scope, memory, failure };
    });
    const warnings = scopeWarnings(scanned.skippedScopes ?? []);
    // Every scope failed, so no explicit scope could succeed either.
    if (!scanned.ok) return scanned;
    // Project takes precedence, so only a failed project scan can hide the answer.
    const refusal = refuseUnlessExplicit(!input.scope, scanned.skippedScopes, "answer", (reasons) => `Cannot resolve "${input.name}" safely because a scope scan failed; pass an explicit scope to read: ${reasons}`);
    if (refusal) return refusal;
    // The first scope holding the name in precedence order answers; an unreadable copy of
    // that name is reported instead of falling through to a lower-precedence scope.
    const unreadable = scanned.values.find((value) => value.failure);
    if (unreadable?.failure) return { ok: false, error: unreadable.failure, ...warnings };
    const hit = scanned.values.find((value) => value.memory);
    const memory = hit?.memory ? { ...hit.memory, scope: hit.scope } : undefined;
    if (memory) return { ok: true, memory, ...warnings };
    // A clean project miss falls through to the global result, including its own failure.
    const globalFailure = scanned.skippedScopes?.find(({ scope }) => scope === "global");
    if (globalFailure) return { ok: false, error: reasonText([globalFailure]), ...warnings };
    return { ok: false, error: "Memory not found", ...warnings };
  }

  async function remove(input: { scope?: MemoryScope; name: string }): Promise<({ ok: true; skipped?: SkippedScope[] } & ScopeWarnings) | ResultError> {
    if (options.incognito) return incognitoRefusal("removal");
    if (!validName(input.name)) return { ok: false, error: "Invalid memory name" };
    try {
      const skipped: SkippedScope[] = [];
      const skip = (scope: MemoryScope) => skipped.push({ scope, reason: "Only regular, non-symlink memory files can be removed" });
      const scanned = await visitScopes(input.scope, async (scope) => {
        const dir = await directory(scope, false);
        if (!dir) return null;
        let handle: nodeFs.FileHandle | undefined;
        try {
          const path = join(dir, `${input.name}.md`);
          const stat = await fs.lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) { skip(scope); return null; }
          handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          if (!(await handle.stat()).isFile()) { skip(scope); return null; }
          return { dir, scope };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ELOOP") skip(scope);
          else if (!missing(error)) throw error;
        }
        finally { if (handle) await handle.close(); }
        return null;
      });
      if (!scanned.ok) return scanned;
      const warnings = scopeWarnings(scanned.skippedScopes ?? []);
      // A failed scan cannot rule out a same-named memory in that scope, so an unscoped delete is unsafe.
      const refusal = refuseUnlessExplicit(!input.scope, scanned.skippedScopes, "removal", (reasons) => `Cannot rule out another "${input.name}" memory because a scope scan failed; pass an explicit scope to delete: ${reasons}`);
      if (refusal) return refusal;
      const found = scanned.values.filter((match) => match !== null);
      if (found.length > 1) return { ok: false, error: "Memory exists in both project and global scopes; specify scope", ...warnings };
      const match = found[0];
      if (!match) return { ok: false, error: skipped.length ? `Only regular, non-symlink memory files can be removed; skipped ${skipped.map(({ scope }) => scope).join(", ")} scopes` : "Memory not found", ...warnings };
      await fs.unlink(join(match.dir, `${input.name}.md`));
      await refreshIndexFile(match.scope);
      return { ok: true, ...warnings, ...(skipped.length ? { skipped } : {}) };
    } catch (error) { return errorResult(error); }
  }

  async function list(input: { scope?: MemoryScope } = {}): Promise<({ ok: true; entries: ListEntry[]; skipped: number } & ScopeWarnings) | ({ entries: ListEntry[]; skipped: number } & ResultError)> {
    try {
      const result: ListEntry[] = [];
      let skipped = 0;
      const scanned = await visitScopes(input.scope, async (scope) => ({ scope, ...await entries(scope, true) }));
      if (!scanned.ok) return { ...scanned, entries: [], skipped: 0 };
      for (const data of scanned.values) {
        const { scope } = data;
        skipped += data.skipped;
        for (const { body: _body, ...memory } of data.memories) {
          const age = Math.max(0, Math.floor((now().getTime() - Date.parse(memory.updated)) / 86400000));
          result.push({ ...memory, scope, age, stale: age > 90 });
        }
      }
      result.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
      return { ok: true, entries: result, skipped, ...scopeWarnings(scanned.skippedScopes ?? []) };
    } catch (error) { return { ...errorResult(error), entries: [], skipped: 0 }; }
  }
  async function buildMemoryIndex(input: { scope?: MemoryScope } = {}): Promise<MemoryIndex & (({ ok: true } & ScopeWarnings) | ResultError)> {
    const data = await list(input);
    if (!data.ok) return { ...data, text: "", truncated: false, shown: 0, total: 0 };
    return { ok: true, ...scopeWarnings(data.skippedScopes ?? []), ...renderMemoryIndex({ entries: data.entries }) };
  }
  async function recall(input: { query?: string; name?: string; scope?: MemoryScope }): Promise<({ ok: true; memory: ScopedMemory } & ScopeWarnings) | ({ ok: true; matches: RecallMatch[] } & ScopeWarnings) | ResultError> {
    if ((input.query !== undefined) === (input.name !== undefined)) return { ok: false, error: "Provide exactly one of query or name" };
    if (input.name !== undefined) return read({ name: input.name, scope: input.scope });
    // A query always searches both scopes, so a scope here would be silently ignored.
    if (input.scope !== undefined) return { ok: false, error: "scope applies only to a name lookup" };
    if (typeof input.query !== "string") return { ok: false, error: "Query must be a string" };
    const invalid = validateQueryPolicy(input.query);
    if (invalid) return { ok: false, error: invalid };
    try {
      const memories: ScopedMemory[] = [];
      const scanned = await visitScopes(undefined, async (scope) => ({ scope, ...await entries(scope) }));
      if (!scanned.ok) return scanned;
      for (const { scope, memories: entries } of scanned.values) {
        for (const memory of entries) memories.push({ ...memory, scope });
      }
      return { ok: true, matches: rankMemories(memories, input.query), ...scopeWarnings(scanned.skippedScopes ?? []) };
    } catch (error) { return errorResult(error); }
  }
  /** Derived convenience copy only. A failed refresh is observable here but never
   * changes the result of an already-committed write or removal. Never read back. */
  async function refreshIndexFile(scope: MemoryScope): Promise<{ ok: true } | ResultError> {
    if (options.incognito) return incognitoRefusal("writes");
    try {
      const data = await list({ scope });
      if (!data.ok) return errorResult(new Error(data.error));
      const dir = await directory(scope, true);
      if (!dir) throw new Error("Memory directory unavailable");
      // The copy lives inside the scope directory, so its links are relative to it.
      await atomicReplace(dir, "MEMORY.md", renderMemoryIndex({ entries: data.entries, links: "relative" }).text);
      return { ok: true };
    } catch (error) { return errorResult(error); }
  }
  return { write, read, remove, list, buildMemoryIndex, recall, refreshIndexFile };
}
