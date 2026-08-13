/**
 * LSP protocol mappers (issue #11 Phase 3).
 * Agent-facing ranges are 1-based; protocol positions are 0-based.
 */

import {
  fileUriToPath,
  type CompletionKind,
  type LspCompletionItem,
  type LspHover,
  type LspLocation,
  type LspPosition,
  type LspRange,
  type LspTextEdit,
} from "./types.js";

export const HOVER_MAX_CHARS = 2000;
export const COMPLETION_MAX = 20;
export const DETAIL_MAX_CHARS = 200;
export const DEFINITION_MAX = 20;
export const REFERENCES_MAX = 50;
export const CODE_ACTIONS_MAX = 20;

const COMPLETION_KIND: Record<number, CompletionKind> = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  11: "other",
  12: "other",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "other",
  17: "file",
  18: "other",
  19: "folder",
  20: "enumMember",
  21: "constant",
  22: "struct",
  23: "other",
  24: "operator",
  25: "typeParameter",
};

export function agentToLspPosition(line: number, col: number): LspPosition {
  return { line: line - 1, character: col - 1 };
}

export function agentToLspRange(
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): LspRange {
  return {
    start: agentToLspPosition(startLine, startCol),
    end: agentToLspPosition(endLine, endCol),
  };
}

export function completionKindFromLsp(
  kind: number | undefined,
): CompletionKind | undefined {
  if (kind === undefined || !Number.isFinite(kind)) return undefined;
  return COMPLETION_KIND[kind];
}

function markedKind(part: unknown): "markdown" | "plaintext" {
  if (part && typeof part === "object" && "kind" in part) {
    const k = (part as { kind?: unknown }).kind;
    if (k === "markdown") return "markdown";
  }
  return "plaintext";
}

function markedText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part && typeof part === "object") {
    const o = part as { value?: unknown };
    if (typeof o.value === "string") return o.value;
  }
  return "";
}

export function normalizeHover(raw: unknown): LspHover | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const contents = (raw as { contents?: unknown }).contents;
  if (contents === undefined || contents === null) return null;

  const parts = Array.isArray(contents) ? contents : [contents];
  let kind: "markdown" | "plaintext" = "plaintext";
  const texts: string[] = [];
  for (const part of parts) {
    if (markedKind(part) === "markdown") kind = "markdown";
    const t = markedText(part);
    if (t) texts.push(t);
  }
  const joined = texts.join("\n").trim();
  if (!joined) return null;
  return {
    contents: joined.slice(0, HOVER_MAX_CHARS),
    kind,
  };
}

function completionItemsFrom(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

export function truncateCompletions(raw: unknown): {
  completions: LspCompletionItem[];
  truncated: boolean;
} {
  const items = completionItemsFrom(raw);
  const truncated = items.length > COMPLETION_MAX;
  const completions: LspCompletionItem[] = [];
  for (const item of items.slice(0, COMPLETION_MAX)) {
    if (!item || typeof item !== "object") continue;
    const o = item as { label?: unknown; kind?: unknown; detail?: unknown };
    if (typeof o.label !== "string" || o.label.length === 0) continue;
    const mapped: LspCompletionItem = { label: o.label };
    const kind = completionKindFromLsp(
      typeof o.kind === "number" ? o.kind : undefined,
    );
    if (kind) mapped.kind = kind;
    if (typeof o.detail === "string" && o.detail.length > 0) {
      mapped.detail = o.detail.slice(0, DETAIL_MAX_CHARS);
    }
    completions.push(mapped);
  }
  return { completions, truncated };
}

function inWorkspace(path: string, workspaceRoot: string): boolean {
  const root = workspaceRoot.replace(/\/+$/, "") || workspaceRoot;
  return path === root || path.startsWith(root + "/");
}

function locationFromRange(
  uri: string,
  range: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined,
  workspaceRoot: string,
): LspLocation | null {
  const path = fileUriToPath(uri);
  if (!path || !inWorkspace(path, workspaceRoot)) return null;
  const startLine = (range?.start?.line ?? 0) + 1;
  const startCol = (range?.start?.character ?? 0) + 1;
  const endLine = (range?.end?.line ?? (range?.start?.line ?? 0)) + 1;
  const endCol = (range?.end?.character ?? (range?.start?.character ?? 0)) + 1;
  return { path, startLine, startCol, endLine, endCol };
}

export function mapLocations(raw: unknown, workspaceRoot: string): LspLocation[] {
  if (raw === null || raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: LspLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as {
      uri?: unknown;
      range?: {
        start?: { line?: number; character?: number };
        end?: { line?: number; character?: number };
      };
      targetUri?: unknown;
      targetRange?: {
        start?: { line?: number; character?: number };
        end?: { line?: number; character?: number };
      };
      targetSelectionRange?: {
        start?: { line?: number; character?: number };
        end?: { line?: number; character?: number };
      };
    };
    if (typeof o.targetUri === "string") {
      const loc = locationFromRange(
        o.targetUri,
        o.targetSelectionRange ?? o.targetRange,
        workspaceRoot,
      );
      if (loc) out.push(loc);
      continue;
    }
    if (typeof o.uri === "string") {
      const loc = locationFromRange(o.uri, o.range, workspaceRoot);
      if (loc) out.push(loc);
    }
  }
  return out;
}

export type FlattenOk = {
  ok: true;
  files: Map<string, LspTextEdit[]>;
};
export type FlattenErr = { ok: false; reason: "resource_op" | "invalid_uri" };
export type FlattenResult = FlattenOk | FlattenErr;

function asTextEdit(raw: unknown): LspTextEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as {
    newText?: unknown;
    range?: {
      start?: { line?: number; character?: number };
      end?: { line?: number; character?: number };
    };
  };
  if (typeof o.newText !== "string" || !o.range) return null;
  return {
    newText: o.newText,
    range: {
      start: {
        line: o.range.start?.line ?? 0,
        character: o.range.start?.character ?? 0,
      },
      end: {
        line: o.range.end?.line ?? 0,
        character: o.range.end?.character ?? 0,
      },
    },
  };
}

function pushEdits(
  files: Map<string, LspTextEdit[]>,
  uri: string,
  edits: unknown[],
): FlattenErr | null {
  const path = fileUriToPath(uri);
  if (!path) return { ok: false, reason: "invalid_uri" };
  const list = files.get(path) ?? [];
  for (const e of edits) {
    const te = asTextEdit(e);
    if (te) list.push(te);
  }
  files.set(path, list);
  return null;
}

export function flattenWorkspaceEdit(edit: unknown): FlattenResult {
  if (!edit || typeof edit !== "object") {
    return { ok: true, files: new Map() };
  }
  const o = edit as {
    changes?: Record<string, unknown>;
    documentChanges?: unknown[];
  };
  const files = new Map<string, LspTextEdit[]>();

  if (Array.isArray(o.documentChanges)) {
    for (const change of o.documentChanges) {
      if (!change || typeof change !== "object") continue;
      const c = change as {
        kind?: unknown;
        uri?: unknown;
        textDocument?: { uri?: unknown };
        edits?: unknown[];
      };
      if (c.kind === "create" || c.kind === "rename" || c.kind === "delete") {
        return { ok: false, reason: "resource_op" };
      }
      const uri =
        typeof c.textDocument?.uri === "string"
          ? c.textDocument.uri
          : typeof c.uri === "string"
            ? c.uri
            : null;
      if (!uri) continue;
      const err = pushEdits(files, uri, Array.isArray(c.edits) ? c.edits : []);
      if (err) return err;
    }
  }

  if (o.changes && typeof o.changes === "object") {
    for (const [uri, edits] of Object.entries(o.changes)) {
      const err = pushEdits(files, uri, Array.isArray(edits) ? edits : []);
      if (err) return err;
    }
  }

  return { ok: true, files };
}

export function isApplicableCodeAction(
  action: unknown,
  resolveProvider: boolean,
): boolean {
  if (!action || typeof action !== "object") return false;
  const a = action as {
    title?: unknown;
    edit?: unknown;
    data?: unknown;
    command?: unknown;
  };
  if (typeof a.title !== "string") return false;
  if (a.edit !== null && a.edit !== undefined && typeof a.edit === "object") {
    return true;
  }
  if (a.data !== undefined && resolveProvider) return true;
  return false;
}
