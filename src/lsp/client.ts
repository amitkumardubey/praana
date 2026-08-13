/**
 * Stdio JSON-RPC LSP client (issue #11 Phase 2).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { FrameParser, encodeMessage } from "./framing.js";
import {
  fileUriToPath,
  isJsonRpcResponse,
  pathToFileUri,
  severityFromLsp,
  type JsonRpcId,
  type JsonRpcMessage,
  type LspDiagnostic,
  type LspErrorCode,
  type LspPosition,
  type LspRange,
  type LspTextEdit,
} from "./types.js";

export class LspClientError extends Error {
  readonly code: LspErrorCode;

  constructor(code: LspErrorCode, message: string) {
    super(message);
    this.name = "LspClientError";
    this.code = code;
  }
}

export interface LspClientStartOptions {
  command: string[];
  cwd: string;
  rootUri: string;
  timeoutMs: number;
  /** Extra env vars for the child process. */
  env?: Record<string, string | undefined>;
  /** Override spawn for tests. */
  spawnFn?: typeof spawn;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser = new FrameParser();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly notificationHandlers = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  private readonly diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private readonly sentVersion = new Map<string, number>();
  private readonly publishedVersion = new Map<string, number>();
  private readonly publishCount = new Map<string, number>();
  private readonly syncCount = new Map<string, number>();
  private nextId = 1;
  private closed = false;
  private documentFormattingProvider = false;
  private hoverProvider = false;
  private completionProvider = false;
  private definitionProvider = false;
  private referencesProvider = false;
  private codeActionProvider = false;
  private resolveProvider = false;
  readonly timeoutMs: number;
  readonly rootUri: string;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    opts: { timeoutMs: number; rootUri: string },
  ) {
    this.child = child;
    this.timeoutMs = opts.timeoutMs;
    this.rootUri = opts.rootUri;

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        const msgs = this.parser.append(chunk);
        for (const msg of msgs) this.dispatch(msg);
      } catch (err) {
        this.failAll(
          new LspClientError(
            "protocol_error",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    });

    child.on("error", (err) => {
      this.failAll(
        new LspClientError("unavailable", `LSP process error: ${err.message}`),
      );
    });

    child.on("exit", () => {
      this.closed = true;
      this.failAll(new LspClientError("unavailable", "LSP process exited"));
    });
  }

  static async start(opts: LspClientStartOptions): Promise<LspClient> {
    if (!opts.command.length || !opts.command[0]) {
      throw new LspClientError("invalid_argument", "Empty LSP server command");
    }

    const spawnFn = opts.spawnFn ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    const childEnv = { ...process.env, ...(opts.env ?? {}) };
    try {
      child = spawnFn(opts.command[0], opts.command.slice(1), {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      throw new LspClientError(
        "unavailable",
        `Failed to spawn LSP server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Spawn failures for missing executables often surface as 'error' async event
    const spawnError = await new Promise<Error | null>((resolve) => {
      const onError = (err: Error) => {
        cleanup();
        resolve(err);
      };
      const onSpawn = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
      // Some runtimes may have already spawned
      if (child.pid) {
        cleanup();
        resolve(null);
      }
    });

    if (spawnError) {
      throw new LspClientError(
        "unavailable",
        `Failed to spawn LSP server: ${spawnError.message}`,
      );
    }

    const client = new LspClient(child, {
      timeoutMs: opts.timeoutMs,
      rootUri: opts.rootUri,
    });

    try {
      const result = (await client.request("initialize", {
        processId: process.pid,
        rootUri: opts.rootUri,
        capabilities: {
          textDocument: {
            publishDiagnostics: {},
            formatting: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: { completionItem: { snippetSupport: false } },
            definition: { linkSupport: true },
            references: {},
            codeAction: { resolveSupport: { properties: ["edit"] } },
          },
          workspace: {
            workspaceFolders: true,
          },
        },
        workspaceFolders: [
          {
            uri: opts.rootUri,
            name: "praana",
          },
        ],
      })) as {
        capabilities?: {
          documentFormattingProvider?: boolean | object;
          hoverProvider?: boolean | object;
          completionProvider?: boolean | object;
          definitionProvider?: boolean | object;
          referencesProvider?: boolean | object;
          codeActionProvider?: boolean | { resolveProvider?: boolean };
        };
      };

      const caps = result?.capabilities;
      client.documentFormattingProvider = Boolean(
        caps?.documentFormattingProvider,
      );
      client.hoverProvider = Boolean(caps?.hoverProvider);
      client.completionProvider = Boolean(caps?.completionProvider);
      client.definitionProvider = Boolean(caps?.definitionProvider);
      client.referencesProvider = Boolean(caps?.referencesProvider);
      const ca = caps?.codeActionProvider;
      client.codeActionProvider = Boolean(ca);
      client.resolveProvider =
        typeof ca === "object" && ca !== null && Boolean(ca.resolveProvider);
      await client.notify("initialized", {});
      return client;
    } catch (err) {
      await client.shutdown().catch(() => {});
      throw err;
    }
  }

  get supportsFormatting(): boolean {
    return this.documentFormattingProvider;
  }

  get supportsHover(): boolean {
    return this.hoverProvider;
  }

  get supportsCompletion(): boolean {
    return this.completionProvider;
  }

  get supportsDefinition(): boolean {
    return this.definitionProvider;
  }

  get supportsReferences(): boolean {
    return this.referencesProvider;
  }

  get supportsCodeAction(): boolean {
    return this.codeActionProvider;
  }

  get supportsResolve(): boolean {
    return this.resolveProvider;
  }

  getDiagnostics(uri: string): LspDiagnostic[] {
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  /**
   * Wait until the server has published diagnostics for `uri` after our most
   * recent didOpen/didChange, then return them. Servers such as
   * typescript-language-server compute diagnostics asynchronously after a
   * document is opened or changed, so a fixed sleep is unreliable. We poll
   * until either the server echoes a document `version` >= the one we sent, or
   * (for servers that omit `version`) until a new publish arrives since our
   * sync. Falls back to returning whatever is available after `timeoutMs`.
   */
  async waitForDiagnostics(
    uri: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<LspDiagnostic[]> {
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const intervalMs = opts?.intervalMs ?? 20;
    const targetVersion = this.sentVersion.get(uri) ?? 0;
    const sinceCount = this.syncCount.get(uri) ?? 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const publishedVersion = this.publishedVersion.get(uri);
      const count = this.publishCount.get(uri) ?? 0;
      if (publishedVersion !== undefined && publishedVersion >= targetVersion) {
        return this.getDiagnostics(uri);
      }
      if (publishedVersion === undefined && count > sinceCount) {
        return this.getDiagnostics(uri);
      }
      await sleep(intervalMs);
    }
    return this.getDiagnostics(uri);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (this.closed) {
      throw new LspClientError("unavailable", "LSP client is closed");
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const payload = {
      jsonrpc: "2.0" as const,
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new LspClientError(
            "timeout",
            `LSP request timed out: ${method} (${timeoutMs}ms)`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      try {
        this.child.stdin.write(encodeMessage(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new LspClientError(
            "io_error",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      throw new LspClientError("unavailable", "LSP client is closed");
    }
    const payload = {
      jsonrpc: "2.0" as const,
      method,
      params,
    };
    try {
      this.child.stdin.write(encodeMessage(payload));
    } catch (err) {
      throw new LspClientError(
        "io_error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async didOpen(absPath: string, languageId: string, text: string): Promise<void> {
    const uri = pathToFileUri(absPath);
    this.syncCount.set(uri, this.publishCount.get(uri) ?? 0);
    this.sentVersion.set(uri, 1);
    await this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
  }

  async didChange(absPath: string, text: string, version = 2): Promise<void> {
    const uri = pathToFileUri(absPath);
    this.syncCount.set(uri, this.publishCount.get(uri) ?? 0);
    this.sentVersion.set(uri, version);
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async hover(absPath: string, position: LspPosition): Promise<unknown> {
    return this.request("textDocument/hover", {
      textDocument: { uri: pathToFileUri(absPath) },
      position,
    });
  }

  async completion(absPath: string, position: LspPosition): Promise<unknown> {
    return this.request("textDocument/completion", {
      textDocument: { uri: pathToFileUri(absPath) },
      position,
    });
  }

  async definition(absPath: string, position: LspPosition): Promise<unknown> {
    return this.request("textDocument/definition", {
      textDocument: { uri: pathToFileUri(absPath) },
      position,
    });
  }

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

  async formatDocument(
    absPath: string,
    opts?: { timeoutMs?: number },
  ): Promise<LspTextEdit[]> {
    if (!this.documentFormattingProvider) {
      throw new LspClientError(
        "unsupported",
        "Server does not support document formatting",
      );
    }
    const uri = pathToFileUri(absPath);
    const result = await this.request<LspTextEdit[] | null>(
      "textDocument/formatting",
      {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true },
      },
      opts,
    );
    return Array.isArray(result) ? result : [];
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      this.killChild();
      return;
    }
    try {
      await this.request("shutdown", null);
      await this.notify("exit", undefined);
    } catch {
      // best-effort
    } finally {
      this.closed = true;
      this.failAll(new LspClientError("cancelled", "LSP client shutting down"));
      await this.waitForExit(500);
      this.killChild();
    }
  }

  private waitForExit(ms: number): Promise<void> {
    if (this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(), ms);
      this.child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private killChild(): void {
    try {
      if (this.child.exitCode === null && !this.child.killed) {
        this.child.kill("SIGTERM");
      }
    } catch {
      // ignore
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      if (msg.id === null || msg.id === undefined) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if ("error" in msg && msg.error) {
        pending.reject(
          new LspClientError(
            "protocol_error",
            msg.error.message ?? "LSP error response",
          ),
        );
      } else {
        pending.resolve((msg as { result: unknown }).result);
      }
      return;
    }

    if ("method" in msg && typeof msg.method === "string") {
      if (msg.method === "textDocument/publishDiagnostics") {
        this.handlePublishDiagnostics(msg.params);
      }
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch {
            // ignore handler errors
          }
        }
      }
    }
  }

  private handlePublishDiagnostics(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const p = params as {
      uri?: string;
      diagnostics?: Array<{
        message?: string;
        severity?: number;
        source?: string;
        code?: string | number;
        range?: {
          start?: { line?: number; character?: number };
          end?: { line?: number; character?: number };
        };
      }>;
    };
    if (typeof p.uri !== "string" || !Array.isArray(p.diagnostics)) return;
    const uri = p.uri;
    this.publishCount.set(uri, (this.publishCount.get(uri) ?? 0) + 1);
    const version = (params as { version?: number }).version;
    if (typeof version === "number") {
      this.publishedVersion.set(uri, version);
    }
    const path = fileUriToPath(uri) ?? uri;
    const diags: LspDiagnostic[] = p.diagnostics.map((d) => {
      const startLine = (d.range?.start?.line ?? 0) + 1;
      const startCol = (d.range?.start?.character ?? 0) + 1;
      const endLine = (d.range?.end?.line ?? startLine - 1) + 1;
      const endCol = (d.range?.end?.character ?? startCol - 1) + 1;
      return {
        path,
        message: d.message ?? "",
        severity: severityFromLsp(d.severity),
        source: d.source,
        code: d.code,
        startLine,
        startCol,
        endLine,
        endCol,
      };
    });
    this.diagnosticsByUri.set(p.uri, diags);
  }
}
