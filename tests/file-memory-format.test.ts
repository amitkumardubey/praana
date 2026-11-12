import { describe, expect, test } from "bun:test";
import { parseMemory, sanitizeDescription, serializeMemory, validateMemory } from "../src/file-memory/format.js";

const entry = { name: "example", description: "A useful note", type: "user" as const, updated: "2026-01-02", body: "Hello world" };

describe("file memory format", () => {
  test("round trips valid content and skips malformed frontmatter", () => {
    expect(parseMemory(serializeMemory(entry))).toEqual(entry);
    expect(parseMemory("---\nname: [\n---\nbody")).toBeNull();
    expect(parseMemory(`---\n${"x".repeat(9000)}\n---\nbody`)).toBeNull();
  });
  test("validates names, descriptions, byte limits and policy", () => {
    for (const name of ["../x", "a/b", ".hidden", "/abs", "Upper", "a".repeat(65), "memory", "con", "com9", "lpt1", "nul", "aux", "prn"]) {
      expect(validateMemory({ ...entry, name })).not.toBeNull();
    }
    expect(validateMemory({ ...entry, description: "bad\nline" })).not.toBeNull();
    expect(validateMemory({ ...entry, description: "a".repeat(301) })).not.toBeNull();
    expect(validateMemory({ ...entry, body: "é".repeat(1024) + "x" })).not.toBeNull();
    for (const type of ["feedback", "project"] as const) {
      expect(validateMemory({ ...entry, type })).not.toBeNull();
      expect(validateMemory({ ...entry, type, body: "**Why:** reason\n**How to apply:** action" })).toBeNull();
    }
  });
  test("sanitizes control and markdown structure", () => {
    const safe = sanitizeDescription("note\n- [fake] `x` #heading\u0000");
    expect(safe).not.toContain("\n");
    expect(safe).not.toContain("\u0000");
    expect(safe).toContain("\\[");
    expect(safe).toContain("\\`");
    expect(sanitizeDescription("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});
