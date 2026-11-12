import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecretsStrict } from "../redact/secrets.js";
import { parseMemory, serializeMemory, validName, validateMemory, type Memory, type MemoryInput } from "./format.js";
import { memoryDirectories, projectKey, type MemoryScope } from "./paths.js";

export interface StoreOptions {
  home: string;
  cwd: string;
  now?: () => Date;
  fs?: typeof nodeFs;
  incognito?: boolean;
  findRoot?: (cwd: string) => string;
}
type ResultError = { ok: false; error: string; similar?: Array<{ name: string; description: string }> };
type ListEntry = Omit<Memory, "body"> & { scope: MemoryScope; age: number; stale: boolean };
const scopes: MemoryScope[] = ["project", "global"];
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const errorResult = (error: unknown): ResultError => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
const inside = (parent: string, child: string) => { const p = relative(parent, child); return p === "" || (!p.startsWith(`..${sep}`) && p !== ".." && !isAbsolute(p)); };

/** Atomic replacement is last-writer-wins. Duplicate and created results are advisory under races.
 * Orphan temp files are ignored, not collected. Hand-edited files are not secret-scanned. */
export function createFileMemoryStore(options: StoreOptions) {
  const fs = options.fs ?? nodeFs;
  const home = resolve(options.home);
  const dirs = memoryDirectories(home, projectKey(options.cwd, options.findRoot));
  const now = options.now ?? (() => new Date());

  async function directory(scope: MemoryScope, create: boolean): Promise<string | null> {
    if (!scopes.includes(scope)) throw new Error("Invalid scope");
    const root = await fs.realpath(home);
    const path = dirs[scope];
    let current = home;
    for (const part of relative(home, path).split(sep)) {
      current = join(current, part);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return null;
        try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe memory directory: ${current}`);
      if (!inside(root, await fs.realpath(current))) throw new Error("Memory directory escapes home");
    }
    return path;
  }

  async function readFile(dir: string, name: string): Promise<Memory | null> {
    const path = join(dir, `${name}.md`);
    let handle: nodeFs.FileHandle | undefined;
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return null;
      handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size > 65536) return null;
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 65536) return null;
      const memory = parseMemory(buffer.subarray(0, length).toString("utf8"));
      return memory?.name === name ? memory : null;
    } catch (error) {
      if (missing(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
      throw error;
    } finally { if (handle) await handle.close(); }
  }

  async function entries(scope: MemoryScope): Promise<{ memories: Memory[]; skipped: number; filenames: string[] }> {
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
      const memory = await readFile(dir, name);
      if (memory) memories.push(memory); else skipped++;
    }
    return { memories, skipped, filenames };
  }

  function similar(a: MemoryInput, b: Memory): boolean {
    const normalize = (s: string) => s.replace(/\d+/g, "").replace(/(?:^|-)(?:the|a|an|note|memory)(?=-|$)/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (normalize(a.name) && normalize(a.name) === normalize(b.name)) return true;
    const tokens = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
    const x = tokens(a.description), y = tokens(b.description);
    const union = new Set([...x, ...y]);
    return union.size > 0 && [...x].filter((t) => y.has(t)).length / union.size >= 0.6;
  }

  async function write(input: MemoryInput & { scope: MemoryScope }): Promise<{ ok: true; name: string; scope: MemoryScope; created: boolean } | ResultError> {
    if (options.incognito) return { ok: false, error: "Incognito mode prevents writes" };
    try {
      const invalid = validateMemory(input);
      if (invalid) return { ok: false, error: invalid };
      if (!scopes.includes(input.scope)) return { ok: false, error: "Invalid scope" };
      let redacted: typeof input;
      try { redacted = redactSecretsStrict(input); } catch { return { ok: false, error: "Secret scan failed" }; }
      if (JSON.stringify(redacted) !== JSON.stringify(input)) return { ok: false, error: "Secret-shaped content refused" };
      const existing = await entries(input.scope);
      const targetName = `${input.name}.md`;
      const exists = existing.filenames.includes(targetName);
      if (!exists) {
        const matches = existing.memories.filter((entry) => similar(input, entry)).map(({ name, description }) => ({ name, description }));
        if (matches.length) return { ok: false, error: "Similar memory exists; update it instead", similar: matches };
      }
      if (existing.filenames.some((file) => file.toLowerCase() === targetName.toLowerCase() && file !== targetName)) return { ok: false, error: "Case-insensitive filename collision" };
      const dir = (await directory(input.scope, true))!;
      const target = join(dir, targetName);
      // Refuse to replace a symlink, including a dangling one.
      try { if ((await fs.lstat(target)).isSymbolicLink()) return { ok: false, error: "Symlink memory file refused" }; } catch (error) { if (!missing(error)) throw error; }
      const temp = join(dir, `.${targetName}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
      let createdTemp = false;
      try {
        const handle = await fs.open(temp, "wx", 0o600);
        createdTemp = true;
        try {
          await handle.writeFile(serializeMemory({ ...input, updated: now().toISOString().slice(0, 10) }), "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(temp, target);
        createdTemp = false;
        try { const handle = await fs.open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch { /* Directory fsync is best-effort. */ }
      } finally { if (createdTemp) { try { await fs.unlink(temp); } catch (error) { if (!missing(error)) throw error; } } }
      return { ok: true, name: input.name, scope: input.scope, created: !exists };
    } catch (error) { return errorResult(error); }
  }

  async function read(input: { scope?: MemoryScope; name: string }): Promise<{ ok: true; memory: Memory & { scope: MemoryScope } } | ResultError> {
    if (!validName(input.name)) return { ok: false, error: "Invalid memory name" };
    try {
      for (const scope of input.scope ? [input.scope] : scopes) {
        const dir = await directory(scope, false);
        const memory = dir && await readFile(dir, input.name);
        if (memory) return { ok: true, memory: { ...memory, scope } };
      }
      return { ok: false, error: "Memory not found" };
    } catch (error) { return errorResult(error); }
  }

  async function remove(input: { scope?: MemoryScope; name: string }): Promise<{ ok: true } | ResultError> {
    if (options.incognito) return { ok: false, error: "Incognito mode prevents removal" };
    if (!validName(input.name)) return { ok: false, error: "Invalid memory name" };
    try {
      const found: string[] = [];
      for (const scope of input.scope ? [input.scope] : scopes) {
        const dir = await directory(scope, false);
        if (dir && await readFile(dir, input.name)) found.push(dir);
      }
      if (found.length > 1) return { ok: false, error: "Memory exists in both project and global scopes; specify scope" };
      if (!found.length) return { ok: false, error: "Memory not found" };
      await fs.unlink(join(found[0]!, `${input.name}.md`));
      return { ok: true };
    } catch (error) { return errorResult(error); }
  }

  async function list(input: { scope?: MemoryScope } = {}): Promise<{ ok: true; entries: ListEntry[]; skipped: number } | ({ entries: ListEntry[]; skipped: number } & ResultError)> {
    try {
      const result: ListEntry[] = [];
      let skipped = 0;
      for (const scope of input.scope ? [input.scope] : scopes) {
        const data = await entries(scope);
        skipped += data.skipped;
        for (const { body: _body, ...memory } of data.memories) {
          const age = Math.max(0, Math.floor((now().getTime() - Date.parse(memory.updated)) / 86400000));
          result.push({ ...memory, scope, age, stale: age > 90 });
        }
      }
      result.sort ( (a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
      return { ok: true, entries: result, skipped };
    } catch (error) { return { ...errorResult(error), entries: [], skipped: 0 }; }
  }
  return { write, read, remove, list };
}
