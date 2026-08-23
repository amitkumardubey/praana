/**
 * Session-scoped LSP manager (issue #11 Phases 2–4).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { LspConfig } from "../types.js";
import { LspClient, LspClientError } from "./client.js";
import { applyTextEdits } from "./edits.js";
import {
  languageFromPath,
  lspLanguageId,
  resolveServerArgv,
  resolveServerKey,
} from "./language.js";
import { normalizeRoot, resolveLspRoot } from "./workspace-roots.js";
import {
  CODE_ACTIONS_MAX,
  DEFINITION_MAX,
  REFERENCES_MAX,
  agentToLspPosition,
  agentToLspRange,
  flattenWorkspaceEdit,
  isApplicableCodeAction,
  mapLocations,
  normalizeHover,
  truncateCompletions,
} from "./map.js";
import {
  pathToFileUri,
  type LspCodeActionRow,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspErrorCode,
  type LspHover,
  type LspLocation,
  type LspResult,
} from "./types.js";

export const LSP_MAX_RESTARTS = 3;
export const LSP_BACKOFF_MS = [1000, 2000, 4000] as const;
export const LSP_DEFAULT_MAX_CLIENTS = 8;

export interface LspManagerOptions {
  config: LspConfig;
  cwd: string;
  workspaceRoot: string;
  /** Test injection. */
  startClient?: typeof LspClient.start;
  /** Test injection — default 8. */
  maxClients?: number;
  /** Test injection — skip real backoff. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ApplyLock {
  tryAcquireExtra(
    id: string,
    absPath: string,
  ): { ok: true } | { ok: false; error: string };
}

export interface ApplyCodeActionOptions {
  allowPath?: (abs: string) => boolean;
}

interface CachedAction {
  id: string;
  language: string;
  path: string;
  mtimeMs: number;
  version: number;
  action: unknown;
}

interface ClientSlot {
  client: LspClient;
  root: string;
  serverKey: string;
  restartCount: number;
  lastUsedAt: number;
  inflight: number;
  exhausted: boolean;
}

function fail(code: LspErrorCode, error: string): {
  ok: false;
  error: string;
  code: LspErrorCode;
} {
  return { ok: false, code, error };
}

function err<T = never>(code: LspErrorCode, error: string): LspResult<T> {
  return { ok: false, code, error };
}

function clientKey(root: string, serverKey: string): string {
  return `${normalizeRoot(root)}::${serverKey}`;
}

function diagnosticKey(d: LspDiagnostic): string {
  return [
    d.path,
    d.startLine,
    d.startCol,
    d.endLine,
    d.endCol,
    d.severity,
    d.message,
    d.code ?? "",
  ].join("|");
}

/** Newly introduced diagnostics: in `after` but not in `before`. */
export function diffIntroduced(
  before: LspDiagnostic[],
  after: LspDiagnostic[],
): LspDiagnostic[] {
  const prev = new Set(before.map(diagnosticKey));
  return after.filter((d) => !prev.has(diagnosticKey(d)));
}

export class LspManager {
  private readonly slots = new Map<string, ClientSlot>();
  private readonly starting = new Map<string, Promise<LspClient>>();
  private readonly openDocs = new Set<string>();
  private readonly docVersion = new Map<string, number>();
  private readonly actions = new Map<string, CachedAction>();
  private nextActionId = 1;
  private applyLock: ApplyLock | null = null;
  private readonly config: LspConfig;
  private readonly workspaceRoot: string;
  private readonly startClient: typeof LspClient.start;
  private readonly maxClients: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private shutDown = false;

  constructor(opts: LspManagerOptions) {
    this.config = opts.config;
    this.workspaceRoot = opts.workspaceRoot;
    this.startClient = opts.startClient ?? LspClient.start.bind(LspClient);
    this.maxClients = opts.maxClients ?? LSP_DEFAULT_MAX_CLIENTS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get formatOnEdit(): boolean {
    return this.config.format_on_edit;
  }

  get diagnosticsEnabled(): boolean {
    return this.config.diagnostics;
  }

  setApplyLock(lock: ApplyLock | null): void {
    this.applyLock = lock;
  }

  originatingPathForAction(id: string): string | null {
    return this.actions.get(id)?.path ?? null;
  }

  async hover(
    absPath: string,
    line: number,
    col: number,
  ): Promise<LspResult<{ hover: LspHover | null; skipped?: "unsupported" }>> {
    const pos = this.validatePosition(line, col);
    if (pos) return pos;
    if (!this.config.enabled) return err("disabled", "LSP is disabled");
    return this.withPreparedDocument(absPath, async ({ client }) => {
      if (!client.supportsHover) {
        return { hover: null, skipped: "unsupported" as const };
      }
      const raw = await client.hover(
        absPath,
        agentToLspPosition(line, col),
      );
      return { hover: normalizeHover(raw) };
    });
  }

  async completions(
    absPath: string,
    line: number,
    col: number,
  ): Promise<
    LspResult<{
      completions: LspCompletionItem[];
      truncated?: boolean;
      skipped?: "unsupported";
    }>
  > {
    const pos = this.validatePosition(line, col);
    if (pos) return pos;
    if (!this.config.enabled) return err("disabled", "LSP is disabled");
    return this.withPreparedDocument(absPath, async ({ client }) => {
      if (!client.supportsCompletion) {
        return { completions: [], skipped: "unsupported" as const };
      }
      const raw = await client.completion(
        absPath,
        agentToLspPosition(line, col),
      );
      const { completions, truncated } = truncateCompletions(raw);
      return truncated ? { completions, truncated } : { completions };
    });
  }

  async definition(
    absPath: string,
    line: number,
    col: number,
  ): Promise<
    LspResult<{
      locations: LspLocation[];
      truncated?: boolean;
      skipped?: "unsupported";
    }>
  > {
    return this.locationQuery(
      absPath,
      line,
      col,
      "supportsDefinition",
      (client) => client.definition(absPath, agentToLspPosition(line, col)),
      DEFINITION_MAX,
    );
  }

  async references(
    absPath: string,
    line: number,
    col: number,
  ): Promise<
    LspResult<{
      locations: LspLocation[];
      truncated?: boolean;
      skipped?: "unsupported";
    }>
  > {
    return this.locationQuery(
      absPath,
      line,
      col,
      "supportsReferences",
      (client) => client.references(absPath, agentToLspPosition(line, col)),
      REFERENCES_MAX,
    );
  }

  async codeActions(
    absPath: string,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ): Promise<
    LspResult<{
      actions: LspCodeActionRow[];
      truncated?: boolean;
      skipped?: "unsupported";
    }>
  > {
    const rangeErr = this.validateRange(startLine, startCol, endLine, endCol);
    if (rangeErr) return rangeErr;
    if (!this.config.enabled) return err("disabled", "LSP is disabled");
    return this.withPreparedDocument(absPath, async ({ client, language }) => {
      if (!client.supportsCodeAction) {
        return { actions: [], skipped: "unsupported" as const };
      }
      const raw = await client.codeAction(
        absPath,
        agentToLspRange(startLine, startCol, endLine, endCol),
      );
      const items = Array.isArray(raw) ? raw : [];
      const applicable = items.filter((item) =>
        isApplicableCodeAction(item, client.supportsResolve),
      );
      this.dropActionsForPaths([absPath]);
      const truncated = applicable.length > CODE_ACTIONS_MAX;
      const slice = applicable.slice(0, CODE_ACTIONS_MAX);
      const mtimeMs = this.mtimeOf(absPath);
      const version = this.docVersion.get(absPath) ?? 1;
      const actions: LspCodeActionRow[] = [];
      for (const action of slice) {
        const id = `ca_${this.nextActionId++}`;
        this.actions.set(id, {
          id,
          language,
          path: absPath,
          mtimeMs,
          version,
          action,
        });
        const a = action as {
          title?: unknown;
          kind?: unknown;
          isPreferred?: unknown;
        };
        const row: LspCodeActionRow = {
          id,
          title: typeof a.title === "string" ? a.title : "",
        };
        if (typeof a.kind === "string") row.kind = a.kind;
        if (a.isPreferred === true) row.preferred = true;
        actions.push(row);
      }
      return truncated ? { actions, truncated } : { actions };
    });
  }

  async applyCodeAction(
    id: string,
    opts?: ApplyCodeActionOptions,
  ): Promise<
    LspResult<{
      id: string;
      changed: boolean;
      files: Array<{ path: string; changed: boolean }>;
      skipped?: "unsupported" | "no_edits";
    }>
  > {
    if (!this.config.enabled) return err("disabled", "LSP is disabled");
    const entry = this.actions.get(id);
    if (!entry) {
      return err(
        "invalid_argument",
        "Unknown code action id; call lsp_code_actions again",
      );
    }
    if (this.mtimeOf(entry.path) !== entry.mtimeMs) {
      return err(
        "invalid_argument",
        "Stale code action id; call lsp_code_actions again",
      );
    }

    return this.withPreparedDocument(entry.path, async ({ client, language }) => {
      let action = entry.action as { edit?: unknown };
      if (
        (action.edit === undefined || action.edit === null) &&
        client.supportsResolve
      ) {
        const resolved = await client.resolveCodeAction(action);
        if (resolved && typeof resolved === "object") {
          action = resolved as { edit?: unknown };
        }
      }
      if (action.edit === undefined || action.edit === null) {
        return { id, changed: false, files: [], skipped: "unsupported" as const };
      }
      const flat = flattenWorkspaceEdit(action.edit);
      if (!flat.ok) {
        return { id, changed: false, files: [], skipped: "unsupported" as const };
      }

      const planned: Array<{
        path: string;
        original: string;
        content: string;
      }> = [];
      for (const [target, edits] of flat.files) {
        if (!this.inWorkspace(target)) {
          throw new LspClientError(
            "invalid_argument",
            `Code action target outside workspace: ${target}`,
          );
        }
        if (opts?.allowPath && !opts.allowPath(target)) {
          throw new LspClientError(
            "invalid_argument",
            `Blocked by sandbox: path not in allowed list: ${target}`,
          );
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          throw new LspClientError("io_error", `File not found: ${target}`);
        }
        const original = readFileSync(target, "utf-8");
        const applied = applyTextEdits(original, edits);
        if (!applied.ok) {
          throw new LspClientError("protocol_error", applied.error);
        }
        planned.push({ path: target, original, content: applied.content });
      }

      for (const file of planned) {
        if (file.path === entry.path) continue;
        const lock = this.applyLock?.tryAcquireExtra(id, file.path);
        if (lock && !lock.ok) {
          throw new LspClientError("invalid_argument", lock.error);
        }
      }

      const files = planned.map((f) => ({
        path: f.path,
        changed: f.content !== f.original,
      }));
      if (!files.some((f) => f.changed)) {
        return { id, changed: false, files, skipped: "no_edits" as const };
      }

      for (const file of planned) {
        if (file.content === file.original) continue;
        writeFileSync(file.path, file.content, "utf-8");
        this.openDocs.delete(file.path);
        const fileLang = languageFromPath(file.path) ?? language;
        await this.syncPath(file.path, fileLang, file.content);
      }
      this.dropActionsForPaths(planned.map((f) => f.path));
      return { id, changed: true, files };
    });
  }

  async diagnostics(absPath: string): Promise<LspResult<LspDiagnostic[]>> {
    if (!this.config.enabled) return err("disabled", "LSP is disabled");
    if (!this.config.diagnostics) {
      return err("disabled", "LSP diagnostics are disabled");
    }

    return this.withPreparedDocument(absPath, async ({ client }) => {
      const uri = pathToFileUri(absPath);
      const diags = await client.waitForDiagnostics(uri, {
        timeoutMs: this.config.timeout_ms,
      });
      return diags.slice(0, 50);
    });
  }

  async snapshotDiagnostics(absPath: string): Promise<LspDiagnostic[]> {
    const result = await this.diagnostics(absPath);
    return result.ok ? result.value : [];
  }

  async format(
    absPath: string,
  ): Promise<
    LspResult<{ changed: boolean; skipped?: string; content?: string }>
  > {
    if (!this.config.enabled) return err("disabled", "LSP is disabled");

    return this.withPreparedDocument(absPath, async ({ client, text }) => {
      if (!client.supportsFormatting) {
        return { changed: false, skipped: "unsupported" };
      }
      const edits = await client.formatDocument(absPath);
      if (edits.length === 0) {
        return { changed: false, skipped: "no_edits" };
      }
      const applied = applyTextEdits(text, edits);
      if (!applied.ok) {
        throw new LspClientError("protocol_error", applied.error);
      }
      if (applied.content === text) {
        return { changed: false, skipped: "no_edits" };
      }
      writeFileSync(absPath, applied.content, "utf-8");
      this.openDocs.delete(absPath);
      const language = languageFromPath(absPath);
      if (language) {
        await this.syncDocument(client, absPath, language, applied.content);
      }
      return { changed: true, content: applied.content };
    });
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
    const clients = [...this.slots.values()].map((s) => s.client);
    this.slots.clear();
    this.starting.clear();
    this.openDocs.clear();
    this.docVersion.clear();
    this.actions.clear();
    this.applyLock = null;
    await Promise.all(clients.map((c) => c.shutdown().catch(() => {})));
  }

  private inspectDocument(
    absPath: string,
  ):
    | { ok: true; language: string; text: string }
    | { ok: false; error: string; code: LspErrorCode } {
    if (this.shutDown) return fail("unavailable", "LSP manager shut down");

    const language = languageFromPath(absPath);
    if (!language) {
      return fail("unsupported", `No LSP language mapping for ${absPath}`);
    }

    if (!existsSync(absPath)) {
      return fail("io_error", `File not found: ${absPath}`);
    }
    try {
      if (!statSync(absPath).isFile()) {
        return fail("invalid_argument", `Not a file: ${absPath}`);
      }
    } catch (e) {
      return fail("io_error", e instanceof Error ? e.message : String(e));
    }

    let text: string;
    try {
      text = readFileSync(absPath, "utf-8");
    } catch (e) {
      return fail("io_error", e instanceof Error ? e.message : String(e));
    }

    const lineCount = text.length === 0 ? 0 : text.split("\n").length;
    if (lineCount > this.config.max_file_lines) {
      return fail(
        "unsupported",
        `File exceeds lsp.max_file_lines (${this.config.max_file_lines})`,
      );
    }
    return { ok: true, language, text };
  }

  private async withPreparedDocument<T>(
    absPath: string,
    fn: (ctx: {
      client: LspClient;
      language: string;
      text: string;
    }) => Promise<T>,
  ): Promise<LspResult<T>> {
    const inspected = this.inspectDocument(absPath);
    if (!inspected.ok) return inspected;
    try {
      const value = await this.withClient(
        absPath,
        inspected.language,
        async (client) => {
          await this.syncDocument(
            client,
            absPath,
            inspected.language,
            inspected.text,
          );
          return fn({
            client,
            language: inspected.language,
            text: inspected.text,
          });
        },
      );
      return { ok: true, value };
    } catch (e) {
      return this.mapError(e);
    }
  }

  private async syncPath(
    absPath: string,
    language: string,
    text: string,
  ): Promise<void> {
    await this.withClient(absPath, language, async (client) => {
      await this.syncDocument(client, absPath, language, text);
    });
  }

  private async withClient<T>(
    absPath: string,
    language: string,
    fn: (client: LspClient) => Promise<T>,
  ): Promise<T> {
    const root = resolveLspRoot(absPath, this.workspaceRoot);
    const serverKey = resolveServerKey(language, this.config.servers);
    if (!serverKey) {
      throw new LspClientError(
        "unavailable",
        `No LSP server configured for language '${language}'`,
      );
    }
    const key = clientKey(root, serverKey);

    const run = async (retried: boolean): Promise<T> => {
      if (this.shutDown) {
        throw new LspClientError("unavailable", "LSP manager shut down");
      }
      const client = await this.ensureClient(key, root, serverKey);
      const slot = this.slots.get(key);
      if (slot) {
        slot.lastUsedAt = this.now();
        slot.inflight++;
      }
      try {
        return await fn(client);
      } catch (e) {
        if (
          !retried &&
          slot &&
          this.isCrash(e, client) &&
          !this.shutDown &&
          !slot.exhausted &&
          slot.restartCount < LSP_MAX_RESTARTS
        ) {
          await this.restartSlot(key, root, serverKey);
          return run(true);
        }
        throw e;
      } finally {
        const s = this.slots.get(key);
        if (s && s.inflight > 0) s.inflight--;
      }
    };
    return run(false);
  }

  private isCrash(e: unknown, client: LspClient): boolean {
    if (!(e instanceof LspClientError)) return false;
    if (e.code !== "unavailable") return false;
    if (client.isClosed) return true;
    return /exited|process error/i.test(e.message);
  }

  private async ensureClient(
    key: string,
    root: string,
    serverKey: string,
  ): Promise<LspClient> {
    const existing = this.slots.get(key);
    if (existing?.exhausted && existing.client.isClosed) {
      throw new LspClientError(
        "unavailable",
        "LSP server restart budget exhausted",
      );
    }
    if (existing && !existing.client.isClosed) return existing.client;
    if (existing?.client.isClosed) {
      if (existing.exhausted || existing.restartCount >= LSP_MAX_RESTARTS) {
        existing.exhausted = true;
        throw new LspClientError(
          "unavailable",
          "LSP server restart budget exhausted",
        );
      }
      await this.restartSlot(key, root, serverKey);
      const slot = this.slots.get(key);
      if (!slot || slot.client.isClosed) {
        throw new LspClientError("unavailable", "LSP process exited");
      }
      return slot.client;
    }
    return this.spawnSlot(key, root, serverKey, 0);
  }

  private async restartSlot(
    key: string,
    root: string,
    serverKey: string,
  ): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot || slot.exhausted || slot.restartCount >= LSP_MAX_RESTARTS) {
      if (slot) slot.exhausted = true;
      throw new LspClientError(
        "unavailable",
        "LSP server restart budget exhausted",
      );
    }
    const delay = LSP_BACKOFF_MS[slot.restartCount] ?? 4000;
    await this.sleep(delay);
    slot.restartCount++;
    await slot.client.shutdown().catch(() => {});
    this.dropActionsForRoot(root);
    const client = await this.spawnProcess(root, serverKey);
    slot.client = client;
    slot.lastUsedAt = this.now();
    await this.restoreDocs(root, client);
    await this.evictLru(key);
  }

  private async spawnSlot(
    key: string,
    root: string,
    serverKey: string,
    restartCount: number,
  ): Promise<LspClient> {
    const inflight = this.starting.get(key);
    if (inflight) return inflight;

    const promise = this.spawnProcess(root, serverKey)
      .then((client) => {
        this.slots.set(key, {
          client,
          root,
          serverKey,
          restartCount,
          lastUsedAt: this.now(),
          inflight: 0,
          exhausted: false,
        });
        this.starting.delete(key);
        return client;
      })
      .catch((e) => {
        this.starting.delete(key);
        throw e;
      });

    this.starting.set(key, promise);
    const client = await promise;
    await this.evictLru(key);
    return client;
  }

  private async spawnProcess(
    root: string,
    serverKey: string,
  ): Promise<LspClient> {
    const argv = resolveServerArgv(serverKey, this.config.servers);
    if (!argv) {
      throw new LspClientError(
        "unavailable",
        `No LSP server configured for language '${serverKey}'`,
      );
    }
    return this.startClient({
      command: argv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: this.config.timeout_ms,
    });
  }

  private async restoreDocs(root: string, client: LspClient): Promise<void> {
    for (const absPath of [...this.openDocs]) {
      if (resolveLspRoot(absPath, this.workspaceRoot) !== root) continue;
      if (!existsSync(absPath)) {
        this.openDocs.delete(absPath);
        this.docVersion.delete(absPath);
        continue;
      }
      const language = languageFromPath(absPath);
      if (!language) continue;
      let text: string;
      try {
        text = readFileSync(absPath, "utf-8");
      } catch {
        continue;
      }
      this.docVersion.set(absPath, 1);
      await client.didOpen(absPath, lspLanguageId(language), text);
    }
  }

  private dropActionsForRoot(root: string): void {
    for (const [id, entry] of this.actions) {
      if (resolveLspRoot(entry.path, this.workspaceRoot) === root) {
        this.actions.delete(id);
      }
    }
  }

  private async evictLru(keepKey: string): Promise<void> {
    if (this.slots.size <= this.maxClients) return;
    let victimKey: string | null = null;
    let oldest = Infinity;
    for (const [key, slot] of this.slots) {
      if (key === keepKey) continue;
      if (slot.inflight > 0) continue;
      if (slot.lastUsedAt < oldest) {
        oldest = slot.lastUsedAt;
        victimKey = key;
      }
    }
    if (!victimKey) return;
    const victim = this.slots.get(victimKey);
    if (!victim) return;
    this.slots.delete(victimKey);
    await victim.client.shutdown().catch(() => {});
  }

  private async syncDocument(
    client: LspClient,
    absPath: string,
    language: string,
    text: string,
  ): Promise<void> {
    if (this.openDocs.has(absPath)) {
      const version = (this.docVersion.get(absPath) ?? 1) + 1;
      this.docVersion.set(absPath, version);
      await client.didChange(absPath, text, version);
    } else {
      this.docVersion.set(absPath, 1);
      await client.didOpen(absPath, lspLanguageId(language), text);
      this.openDocs.add(absPath);
    }
  }

  private async locationQuery(
    absPath: string,
    line: number,
    col: number,
    capability: "supportsDefinition" | "supportsReferences",
    request: (client: LspClient) => Promise<unknown>,
    cap: number,
  ): Promise<
    LspResult<{
      locations: LspLocation[];
      truncated?: boolean;
      skipped?: "unsupported";
    }>
  > {
    const pos = this.validatePosition(line, col);
    if (pos) return pos;
    if (!this.config.enabled) return err("disabled", "LSP is disabled");
    return this.withPreparedDocument(absPath, async ({ client }) => {
      if (!client[capability]) {
        return { locations: [], skipped: "unsupported" as const };
      }
      const raw = await request(client);
      const mapped = mapLocations(raw, this.workspaceRoot);
      const truncated = mapped.length > cap;
      const locations = mapped.slice(0, cap);
      return truncated ? { locations, truncated } : { locations };
    });
  }

  private validatePosition(
    line: number,
    col: number,
  ): LspResult<never> | null {
    if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) {
      return err("invalid_argument", "line and col must be 1-based integers");
    }
    return null;
  }

  private validateRange(
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ): LspResult<never> | null {
    const a = this.validatePosition(startLine, startCol);
    if (a) return a;
    const b = this.validatePosition(endLine, endCol);
    if (b) return b;
    if (
      startLine > endLine ||
      (startLine === endLine && startCol > endCol)
    ) {
      return err("invalid_argument", "range start must precede or equal end");
    }
    return null;
  }

  private mtimeOf(absPath: string): number {
    try {
      return statSync(absPath).mtimeMs;
    } catch {
      return -1;
    }
  }

  private inWorkspace(absPath: string): boolean {
    const root = this.workspaceRoot.replace(/\/+$/, "") || this.workspaceRoot;
    return absPath === root || absPath.startsWith(root + "/");
  }

  private dropActionsForPaths(paths: string[]): void {
    const set = new Set(paths);
    for (const [id, entry] of this.actions) {
      if (set.has(entry.path)) this.actions.delete(id);
    }
  }

  private mapError(e: unknown): LspResult<never> {
    if (e instanceof LspClientError) {
      return err(e.code, e.message);
    }
    return err(
      "internal",
      e instanceof Error ? e.message : String(e),
    );
  }
}
