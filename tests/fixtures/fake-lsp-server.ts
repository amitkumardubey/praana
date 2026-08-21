#!/usr/bin/env bun
/**
 * Deterministic fake LSP server for tests (issue #11 Phase 2–3).
 *
 * Env:
 *   FAKE_LSP_DELAY_MS — delay before responding to requests (except exit)
 *   FAKE_LSP_DIAGNOSTICS — JSON array of Diagnostic-like objects (0-based ranges)
 *   FAKE_LSP_EDITS — JSON array of TextEdit objects
 *   FAKE_LSP_NO_FORMAT — if "1", omit documentFormattingProvider
 *   FAKE_LSP_NO_HOVER / NO_COMPLETION / NO_DEFINITION / NO_REFERENCES / NO_CODE_ACTION
 *   FAKE_LSP_RESOLVE — if "1", advertise codeAction resolveProvider
 *   FAKE_LSP_HOVER / COMPLETIONS / DEFINITION / REFERENCES / CODE_ACTIONS / RESOLVED_EDIT
 */

import { encodeMessage, FrameParser } from "../../src/lsp/framing.js";

const delayMs = Number(process.env.FAKE_LSP_DELAY_MS ?? "0") || 0;
const noFormat = process.env.FAKE_LSP_NO_FORMAT === "1";
const publishDelayMs = Number(process.env.FAKE_LSP_PUBLISH_DELAY_MS ?? "0") || 0;
const noHover = process.env.FAKE_LSP_NO_HOVER === "1";
const noCompletion = process.env.FAKE_LSP_NO_COMPLETION === "1";
const noDefinition = process.env.FAKE_LSP_NO_DEFINITION === "1";
const noReferences = process.env.FAKE_LSP_NO_REFERENCES === "1";
const noCodeAction = process.env.FAKE_LSP_NO_CODE_ACTION === "1";
const resolveProvider = process.env.FAKE_LSP_RESOLVE === "1";

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const scriptedDiagnostics = parseJsonEnv<unknown[]>("FAKE_LSP_DIAGNOSTICS", []);
const scriptedEdits = parseJsonEnv<unknown[]>("FAKE_LSP_EDITS", []);
const scriptedHover = parseJsonEnv<unknown>("FAKE_LSP_HOVER", {
  contents: { kind: "markdown", value: "hover-doc" },
});
const scriptedCompletions = parseJsonEnv<unknown[]>("FAKE_LSP_COMPLETIONS", []);
const scriptedDefinition = parseJsonEnv<unknown>("FAKE_LSP_DEFINITION", null);
const scriptedReferences = parseJsonEnv<unknown[]>("FAKE_LSP_REFERENCES", []);
const scriptedCodeActions = parseJsonEnv<unknown[]>("FAKE_LSP_CODE_ACTIONS", []);
const scriptedResolvedEdit = parseJsonEnv<unknown>("FAKE_LSP_RESOLVED_EDIT", null);

const parser = new FrameParser();
let nextId = 1;
let exiting = false;

function write(msg: object): void {
  process.stdout.write(encodeMessage(msg));
}

async function maybeDelay(): Promise<void> {
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

function publishDiagnostics(uri: string, version?: number): void {
  write({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      version,
      diagnostics: scriptedDiagnostics,
    },
  });
}

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
  const method = typeof msg.method === "string" ? msg.method : null;
  const id = msg.id;

  if (method === "initialize") {
    // Never delay initialize — clients need a warm server for timeout tests.
    write({
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          documentFormattingProvider: !noFormat,
          hoverProvider: !noHover,
          completionProvider: noCompletion ? undefined : {},
          definitionProvider: !noDefinition,
          referencesProvider: !noReferences,
          codeActionProvider: noCodeAction
            ? undefined
            : resolveProvider
              ? { resolveProvider: true }
              : true,
        },
        serverInfo: { name: "fake-lsp", version: "0.0.1" },
      },
    });
    return;
  }

  if (method === "initialized" || method === "textDocument/didClose") {
    return;
  }

  if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    const params = msg.params as {
      textDocument?: { uri?: string; version?: number };
    } | undefined;
    const uri = params?.textDocument?.uri;
    const version = params?.textDocument?.version;
    if (uri) {
      if (publishDelayMs > 0) {
        await new Promise((r) => setTimeout(r, publishDelayMs));
      }
      publishDiagnostics(uri, version);
    }
    return;
  }

  if (method === "textDocument/formatting") {
    await maybeDelay();
    if (typeof id === "undefined") return;
    write({
      jsonrpc: "2.0",
      id,
      result: scriptedEdits,
    });
    return;
  }

  if (method === "textDocument/hover") {
    await maybeDelay();
    if (typeof id === "undefined") return;
    write({ jsonrpc: "2.0", id, result: scriptedHover });
    return;
  }

  if (method === "textDocument/completion") {
    await maybeDelay();
    if (typeof id === "undefined") return;
    write({ jsonrpc: "2.0", id, result: scriptedCompletions });
    return;
  }

  if (method === "textDocument/definition") {
    await maybeDelay();
    if (typeof id === "undefined") return;
    write({ jsonrpc: "2.0", id, result: scriptedDefinition });
    return;
  }

  if (method === "textDocument/references") {
    await maybeDelay();
    if (typeof id === "undefined") return;
    write({ jsonrpc: "2.0", id, result: scriptedReferences });
    return;
  }

  if (method === "textDocument/codeAction") {
    await maybeDelay();
    if (typeof id === "undefined") return;
    write({ jsonrpc: "2.0", id, result: scriptedCodeActions });
    return;
  }

  if (method === "codeAction/resolve") {
    await maybeDelay();
    if (typeof id === "undefined") return;
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    write({
      jsonrpc: "2.0",
      id,
      result: { ...params, edit: scriptedResolvedEdit },
    });
    return;
  }

  if (method === "shutdown") {
    await maybeDelay();
    if (typeof id !== "undefined") {
      write({ jsonrpc: "2.0", id, result: null });
    }
    return;
  }

  if (method === "exit") {
    exiting = true;
    process.exit(0);
  }

  // Respond to unknown requests so clients don't hang
  if (typeof id !== "undefined" && method) {
    await maybeDelay();
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  void nextId;
}

process.stdin.on("data", (chunk: Buffer) => {
  try {
    const msgs = parser.append(chunk);
    for (const msg of msgs) {
      void handleMessage(msg as Record<string, unknown>);
    }
  } catch (err) {
    process.stderr.write(
      `fake-lsp parse error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
});

process.stdin.on("end", () => {
  if (!exiting) process.exit(0);
});
