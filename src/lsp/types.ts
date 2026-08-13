/**
 * LSP client types (issue #11 Phase 2).
 * Agent-facing ranges are 1-based; protocol positions are 0-based.
 */

export type LspErrorCode =
  | "unavailable"
  | "disabled"
  | "invalid_argument"
  | "io_error"
  | "timeout"
  | "unsupported"
  | "protocol_error"
  | "cancelled"
  | "internal";

export interface LspDiagnostic {
  path: string;
  message: string;
  severity: "error" | "warning" | "information" | "hint" | "unknown";
  source?: string;
  code?: string | number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface LspOk<T> {
  ok: true;
  value: T;
}

export interface LspErr {
  ok: false;
  error: string;
  code: LspErrorCode;
}

export type LspResult<T> = LspOk<T> | LspErr;

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export function isJsonRpcResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcSuccess | JsonRpcFailure {
  return "id" in msg && ("result" in msg || "error" in msg);
}

export function pathToFileUri(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized).replace(/#/g, "%23")}`;
  }
  return `file:///${encodeURI(normalized).replace(/#/g, "%23")}`;
}

export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname);
    // Windows file:///C:/... → /C:/... — leave as-is on Unix; strip leading slash on drive paths
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  } catch {
    return null;
  }
}

export function severityFromLsp(
  severity: number | undefined,
): LspDiagnostic["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "unknown";
  }
}
