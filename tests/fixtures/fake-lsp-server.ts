#!/usr/bin/env bun
/**
 * Deterministic fake LSP server for tests (issue #11 Phase 2).
 *
 * Env:
 *   FAKE_LSP_DELAY_MS — delay before responding to requests (except exit)
 *   FAKE_LSP_DIAGNOSTICS — JSON array of Diagnostic-like objects (0-based ranges)
 *   FAKE_LSP_EDITS — JSON array of TextEdit objects
 *   FAKE_LSP_NO_FORMAT — if "1", omit documentFormattingProvider
 */

import { encodeMessage, FrameParser } from "../../src/lsp/framing.js";

const delayMs = Number(process.env.FAKE_LSP_DELAY_MS ?? "0") || 0;
const noFormat = process.env.FAKE_LSP_NO_FORMAT === "1";
const publishDelayMs = Number(process.env.FAKE_LSP_PUBLISH_DELAY_MS ?? "0") || 0;

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
