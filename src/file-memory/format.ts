import { dump, JSON_SCHEMA, load } from "js-yaml";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  updated: string;
  body: string;
}
export type MemoryInput = Omit<Memory, "updated">;

/** The one name rule: `validName` and the tool JSON schema both read this source, so they
 * cannot drift. The negative lookahead carries the reserved names, because `$` in a
 * JavaScript pattern matches only at the very end, so a trailing newline stays rejected. */
const RESERVED_NAME_SOURCE = "(?:memory|con|prn|aux|nul|com[1-9]|lpt[1-9])";
const NAME_SLUG_SOURCE = "[a-z0-9][a-z0-9-]{0,63}";
export const MEMORY_NAME_PATTERN = new RegExp(`^(?!${RESERVED_NAME_SOURCE}$)${NAME_SLUG_SOURCE}$`);
const types = new Set(["user", "feedback", "project", "reference"]);

export function validName(name: unknown): name is string {
  return typeof name === "string" && MEMORY_NAME_PATTERN.test(name);
}

const stopWords = new Set("a an and are as at be been but by for from had has have he her his i if in into is it its me my not of on or our she so than that the their them then there these they this those to too us was we were what when where which who will with you your".split(" "));
export function searchTokens(text: string): string[] {
  return [...new Set((text.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((token) => !stopWords.has(token)))];
}

export function validateQueryPolicy(query: string): string | null {
  return searchTokens(query).length ? null : "Query is empty or contains only stop-words";
}

export function validateMemoryPolicy(input: MemoryInput): string | null {
  if (!input.description.trim() || Array.from(input.description).length > 300 || /[\r\n]/.test(input.description)) return "Description must be one line and at most 300 characters";
  if ((input.type === "feedback" || input.type === "project") && (!/^\*\*Why:\*\*[ \t]*\S/m.test(input.body) || !/^\*\*How to apply:\*\*[ \t]*\S/m.test(input.body))) return "Add **Why:** and **How to apply:** lines";
  return null;
}

export function validateMemory(input: MemoryInput): string | null {
  if (!validName(input.name)) return "Invalid memory name";
  if (!types.has(input.type)) return "Invalid memory type";
  if (typeof input.description !== "string" || typeof input.body !== "string") return "Description and body must be strings";
  if (Buffer.byteLength(input.body, "utf8") > 2048) return "Body exceeds 2048 bytes; split or tighten it";
  return validateMemoryPolicy(input);
}

export function serializeMemory(memory: Memory): string {
  const { name, description, type, updated, body } = memory;
  return `---\n${dump({ name, description, type, updated }, { lineWidth: -1, noRefs: true })}---\n${body}`;
}

export function parseMemory(text: string): Memory | null {
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const fence = /\n---(?:\n|$)/g;
  fence.lastIndex = 4;
  const closing = fence.exec(text);
  const end = closing?.index ?? -1;
  if (end < 0 || Buffer.byteLength(text.slice(0, end), "utf8") > 8192) return null;
  try {
    const value: unknown = load(text.slice(4, end), { schema: JSON_SCHEMA });
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (!validName(data.name) || typeof data.description !== "string" || !data.description.trim() || typeof data.type !== "string" || !types.has(data.type) || typeof data.updated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.updated) || !Number.isFinite(Date.parse(data.updated)) || new Date(data.updated).toISOString().slice(0, 10) !== data.updated) return null;
    return { name: data.name, description: data.description, type: data.type as MemoryType, updated: data.updated, body: text.slice(end + closing![0].length) };
  } catch {
    return null;
  }
}

export function sanitizeDescription(text: string): string {
  return Array.from(text).slice(0, 300).join("")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\\\[\]`]/g, "\\$&")
    .replace(/^(\s*)([-*+#>]|\d+\.)/, (_match, space: string, marker: string) => `${space}${marker.replace(/[-*+#>.]/g, "\\$&")}`);
}
