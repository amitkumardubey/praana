/**
 * Session-scoped LSP manager (issue #11 Phase 2).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { LspConfig } from "../types.js";
import { LspClient, LspClientError } from "./client.js";
import { applyTextEdits } from "./edits.js";
import {
  languageFromPath,
  lspLanguageId,
  resolveServerArgv,
} from "./language.js";
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

export interface LspManagerOptions {
  config: LspConfig;
  cwd: string;
  workspaceRoot: string;
  /** Test injection. */
  startClient?: typeof LspClient.start;
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
  private readonly clients = new Map<string, LspClient>();
  private readonly starting = new Map<string, Promise<LspClient>>();
  private readonly openDocs = new Set<string>();
  private readonly docVersion = new Map<string, number>();
  private readonly actions = new Map<string, CachedAction>();
  private nextActionId = 1;
  private applyLock: ApplyLock | null = null;
  private readonly config: LspConfig;
  private readonly workspaceRoot: string;
  private readonly startClient: typeof LspClient.start;
  private shutDown = false;

  constructor(opts: LspManagerOptions) {
    this.config = opts.config;
    this.workspaceRoot = opts.workspaceRoot;
    this.startClient = opts.startClient ?? LspClient.start.bind(LspClient);
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
    const prep = await this.prepareDocument(absPath);
    if (!prep.ok) return prep;
    if (!prep.client.supportsHover) {
      return { ok: true, value: { hover: null, skipped: "unsupported" } };
    }
    try {
      const raw = await prep.client.hover(
        absPath,
        agentToLspPosition(line, col),
      );
      return { ok: true, value: { hover: normalizeHover(raw) } };
    } catch (e) {
      return this.mapError(e);
    }
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
    const prep = await this.prepareDocument(absPath);
    if (!prep.ok) return prep;
    if (!prep.client.supportsCompletion) {
      return { ok: true, value: { completions: [], skipped: "unsupported" } };
    }
    try {
      const raw = await prep.client.completion(
        absPath,
        agentToLspPosition(line, col),
      );
      const { completions, truncated } = truncateCompletions(raw);
      return {
        ok: true,
        value: truncated ? { completions, truncated } : { completions },
      };
    } catch (e) {
      return this.mapError(e);
    }
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
    const prep = await this.prepareDocument(absPath);
    if (!prep.ok) return prep;
    if (!prep.client.supportsCodeAction) {
      return { ok: true, value: { actions: [], skipped: "unsupported" } };
    }
    try {
      const raw = await prep.client.codeAction(
        absPath,
        agentToLspRange(startLine, startCol, endLine, endCol),
      );
      const items = Array.isArray(raw) ? raw : [];
      const applicable = items.filter((item) =>
        isApplicableCodeAction(item, prep.client.supportsResolve),
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
          language: prep.language,
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
      return {
        ok: true,
        value: truncated ? { actions, truncated } : { actions },
      };
    } catch (e) {
      return this.mapError(e);
    }
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

    const prep = await this.prepareDocument(entry.path);
    if (!prep.ok) return prep;

    try {
      let action = entry.action as { edit?: unknown };
      if (
        (action.edit === undefined || action.edit === null) &&
        prep.client.supportsResolve
      ) {
        const resolved = await prep.client.resolveCodeAction(action);
        if (resolved && typeof resolved === "object") {
          action = resolved as { edit?: unknown };
        }
      }
      if (action.edit === undefined || action.edit === null) {
        return {
          ok: true,
          value: { id, changed: false, files: [], skipped: "unsupported" },
        };
      }
      const flat = flattenWorkspaceEdit(action.edit);
      if (!flat.ok) {
        return {
          ok: true,
          value: { id, changed: false, files: [], skipped: "unsupported" },
        };
      }

      const planned: Array<{
        path: string;
        original: string;
        content: string;
      }> = [];
      for (const [target, edits] of flat.files) {
        if (!this.inWorkspace(target)) {
          return err(
            "invalid_argument",
            `Code action target outside workspace: ${target}`,
          );
        }
        if (opts?.allowPath && !opts.allowPath(target)) {
          return err(
            "invalid_argument",
            `Blocked by sandbox: path not in allowed list: ${target}`,
          );
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          return err("io_error", `File not found: ${target}`);
        }
        const original = readFileSync(target, "utf-8");
        const applied = applyTextEdits(original, edits);
        if (!applied.ok) return err("protocol_error", applied.error);
        planned.push({ path: target, original, content: applied.content });
      }

      for (const file of planned) {
        if (file.path === entry.path) continue;
        const lock = this.applyLock?.tryAcquireExtra(id, file.path);
        if (lock && !lock.ok) {
          return err("invalid_argument", lock.error);
        }
      }

      const files = planned.map((f) => ({
        path: f.path,
        changed: f.content !== f.original,
      }));
      if (!files.some((f) => f.changed)) {
        return {
          ok: true,
          value: { id, changed: false, files, skipped: "no_edits" },
        };
      }

      for (const file of planned) {
        if (file.content === file.original) continue;
        writeFileSync(file.path, file.content, "utf-8");
        this.openDocs.delete(file.path);
        const language = languageFromPath(file.path) ?? prep.language;
        const client = await this.getClient(language);
        await this.syncDocument(client, file.path, language, file.content);
      }
      this.dropActionsForPaths(planned.map((f) => f.path));
      return { ok: true, value: { id, changed: true, files } };
    } catch (e) {
      return this.mapError(e);
    }
  }

  async diagnostics(absPath: string): Promise<LspResult<LspDiagnostic[]>> {
    if (!this.config.enabled) return err("disabled", "LSP is disabled");
    if (!this.config.diagnostics) {
      return err("disabled", "LSP diagnostics are disabled");
    }

    const prep = await this.prepareDocument(absPath);
    if (!prep.ok) return prep;

    const uri = pathToFileUri(absPath);
    // Wait for the server to publish diagnostics for this document version
    // instead of a fixed sleep — real LSP servers compute them asynchronously.
    const diags = await prep.client.waitForDiagnostics(uri, {
      timeoutMs: this.config.timeout_ms,
    });
    return {
      ok: true,
      value: diags.slice(0, 50),
    };
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

    const prep = await this.prepareDocument(absPath);
    if (!prep.ok) return prep;

    if (!prep.client.supportsFormatting) {
      return { ok: true, value: { changed: false, skipped: "unsupported" } };
    }

    try {
      const edits = await prep.client.formatDocument(absPath);
      if (edits.length === 0) {
        return { ok: true, value: { changed: false, skipped: "no_edits" } };
      }
      const applied = applyTextEdits(prep.text, edits);
      if (!applied.ok) {
        return err("protocol_error", applied.error);
      }
      if (applied.content === prep.text) {
        return { ok: true, value: { changed: false, skipped: "no_edits" } };
      }
      writeFileSync(absPath, applied.content, "utf-8");
      this.openDocs.delete(absPath);
      await this.syncDocument(prep.client, absPath, prep.language, applied.content);
      return {
        ok: true,
        value: { changed: true, content: applied.content },
      };
    } catch (e) {
      return this.mapError(e);
    }
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.starting.clear();
    this.openDocs.clear();
    this.docVersion.clear();
    this.actions.clear();
    this.applyLock = null;
    await Promise.all(clients.map((c) => c.shutdown().catch(() => {})));
  }

  private async prepareDocument(
    absPath: string,
  ): Promise<
    | {
        ok: true;
        client: LspClient;
        language: string;
        text: string;
      }
    | { ok: false; error: string; code: LspErrorCode }
  > {
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

    try {
      const client = await this.getClient(language);
      await this.syncDocument(client, absPath, language, text);
      return { ok: true, client, language, text };
    } catch (e) {
      if (e instanceof LspClientError) {
        return fail(e.code, e.message);
      }
      return fail(
        "internal",
        e instanceof Error ? e.message : String(e),
      );
    }
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
    const prep = await this.prepareDocument(absPath);
    if (!prep.ok) return prep;
    if (!prep.client[capability]) {
      return { ok: true, value: { locations: [], skipped: "unsupported" } };
    }
    try {
      const raw = await request(prep.client);
      const mapped = mapLocations(raw, this.workspaceRoot);
      const truncated = mapped.length > cap;
      const locations = mapped.slice(0, cap);
      return {
        ok: true,
        value: truncated ? { locations, truncated } : { locations },
      };
    } catch (e) {
      return this.mapError(e);
    }
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

  private async getClient(language: string): Promise<LspClient> {
    const existing = this.clients.get(language);
    if (existing) return existing;

    const inflight = this.starting.get(language);
    if (inflight) return inflight;

    const argv = resolveServerArgv(language, this.config.servers);
    if (!argv) {
      throw new LspClientError(
        "unavailable",
        `No LSP server configured for language '${language}'`,
      );
    }

    const promise = this.startClient({
      command: argv,
      cwd: this.workspaceRoot,
      rootUri: pathToFileUri(this.workspaceRoot),
      timeoutMs: this.config.timeout_ms,
    }).then((client) => {
      this.clients.set(language, client);
      this.starting.delete(language);
      return client;
    }).catch((e) => {
      this.starting.delete(language);
      throw e;
    });

    this.starting.set(language, promise);
    return promise;
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
