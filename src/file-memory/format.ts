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

const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const reserved = /^(?:memory|con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const types = new Set(["user", "feedback", "project", "reference"]);

export function validName(name: unknown): name is string {
  return typeof name === "string" && namePattern.test(name) && !reserved.test(name);
}

export function validatePolicy(input: MemoryInput): string | null {
  if (!input.description.trim() || input.description.length > 300 || /[\r\n]/.test(input.description)) return "Description must be one line and at most 300 characters";
  if ((input.type === "feedback" || input.type === "project") && (!/^\*\*Why:\*\*[ \t]*\S/m.test(input.body) || !/^\*\*How to apply:\*\*[ \t]*\S/m.test(input.body))) return "Add **Why:** and **How to apply:** lines";
  return null;
}

export function validateMemory(input: MemoryInput): string | null {
  if (!validName(input.name)) return "Invalid memory name";
  if (!types.has(input.type)) return "Invalid memory type";
  if (typeof input.description !== "string" || typeof input.body !== "string") return "Description and body must be strings";
  if (Buffer.byteLength(input.body, "utf8") > 2048) return "Body exceeds 2048 bytes; split or tighten it";
  return validatePolicy(input);
}

export function serializeMemory(memory: Memory): string {
  const { name, description, type, updated, body } = memory;
  return `---\n${dump({ name, description, type, updated }, { lineWidth: -1, noRefs: true })}---\n${body}`;
}

export function parseMemory(text: string): Memory | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0 || Buffer.byteLength(text.slice(0, end), "utf8") > 8192) return null;
  try {
    const value: unknown = load(text.slice(4, end), { schema: JSON_SCHEMA });
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (!validName(data.name) || typeof data.description !== "string" || !data.description.trim() || typeof data.type !== "string" || !types.has(data.type) || typeof data.updated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.updated) || !Number.isFinite(Date.parse(data.updated)) || new Date(data.updated).toISOString().slice(0, 10) !== data.updated) return null;
    return { name: data.name, description: data.description, type: data.type as MemoryType, updated: data.updated, body: text.slice(end + 5) };
  } catch {
    return null;
  }
}

export function sanitizeDescription(text: string): string {
  return Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[-\[\]`#\\]/g, "\\$&")).slice(0, 300).join("");
}
