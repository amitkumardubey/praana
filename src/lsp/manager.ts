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
  pathToFileUri,
  type LspDiagnostic,
  type LspErrorCode,
  type LspResult,
} from "./types.js";

export interface LspManagerOptions {
  config: LspConfig;
  cwd: string;
  workspaceRoot: string;
  /** Test injection. */
  startClient?: typeof LspClient.start;
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
      await client.didChange(absPath, text);
    } else {
      await client.didOpen(absPath, lspLanguageId(language), text);
      this.openDocs.add(absPath);
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
