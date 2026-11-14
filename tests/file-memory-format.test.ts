import { describe, expect, test } from "bun:test";
import { MEMORY_NAME_PATTERN, parseMemory, sanitizeDescription, serializeMemory, validName, validateMemory } from "../src/file-memory/format.js";

const entry = { name: "example", description: "A useful note", type: "user" as const, updated: "2026-01-02", body: "Hello world" };

describe("file memory format", () => {
  test("round trips valid content and skips malformed frontmatter", () => {
    expect(parseMemory(serializeMemory(entry))).toEqual(entry);
    expect(parseMemory("---\nname: [\n---\nbody")).toBeNull();
    expect(parseMemory(`---\n${"x".repeat(9000)}\n---\nbody`)).toBeNull();
    expect(parseMemory("---\nname: example\ndescription: note\ntype: user\nupdated: 2026-02-30\n---\nbody")).toBeNull();
  });
  test("reads BOM, CRLF and closing fences at EOF", () => {
    const text = serializeMemory(entry);
    for (const variant of [text.replace(/\n/g, "\r\n"), `\uFEFF${text}`, `\uFEFF${text.replace(/\n/g, "\r\n")}`]) {
      expect(parseMemory(variant)).toEqual(entry);
    }
    expect(parseMemory(serializeMemory({ ...entry, body: "" }).trimEnd())).toEqual({ ...entry, body: "" });
    expect(parseMemory(serializeMemory({ ...entry, body: "" }))).toEqual({ ...entry, body: "" });
  });
  test("the published name pattern is the whole name rule", () => {
    const pattern = new RegExp(MEMORY_NAME_PATTERN.source);
    const names = [
      "coffee", "a", "a-b-c", "note-1", "0-start",
      // Reserved device and index names fail the pattern, not only the validator.
      "memory", "con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9",
      // Neighbours of the reserved set are ordinary names.
      "com0", "lpt0", "memorys", "console", "nullable",
      "Upper", "Coffee", "-lead", "trail-", "under_score", "two words", "",
      "a".repeat(64), "a".repeat(65),
      // `$` does not match before a trailing newline, so the lookahead cannot smuggle one.
      "coffee\n", "coffee\r\n", "memory\n", "con\n",
    ];
    for (const name of names) expect([name, pattern.test(name)]).toEqual([name, validName(name)]);
    expect(validName("coffee\n")).toBe(false);
    expect(pattern.test("memory\n")).toBe(false);
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
      expect(validateMemory({ ...entry, type, body: "**Why:**\n**How to apply:** action" })).not.toBeNull();
      expect(validateMemory({ ...entry, type, body: "**Why:** reason\n**How to apply:** action" })).toBeNull();
    }
  });
  test("memory policy never switches to query validation for extra keys", () => {
    const extra = { ...entry, query: "search" };
    expect(validateMemory({ ...extra, description: "bad\nline" })).not.toBeNull();
    expect(validateMemory({ ...extra, description: "x".repeat(301) })).not.toBeNull();
    expect(validateMemory({ ...extra, type: "feedback" })).not.toBeNull();
  });
  test("parses unquoted dates and sanitizes hand-edited multiline descriptions", () => {
    const parsed = parseMemory("---\nname: example\ndescription: |\n  note\n  - [fake](x)\ntype: user\nupdated: 2026-01-02\n---\nbody");
    expect(parsed?.updated).toBe("2026-01-02");
    const safe = sanitizeDescription(`${parsed?.description}\u2028- [other]`);
    expect(safe).not.toContain("\n");
    expect(safe).not.toContain("\u2028");
    expect(safe).toContain("\\[");
  });
  test("truncates code points before escaping without changing interior hyphens", () => {
    expect(sanitizeDescription("pre-commit and node-20 #label")).toBe("pre-commit and node-20 #label");
    expect(sanitizeDescription("a".repeat(299) + "[tail")).toBe("a".repeat(299) + "\\[");
    expect(sanitizeDescription("😀".repeat(301))).toBe("😀".repeat(300));
    expect(validateMemory({ ...entry, description: "😀".repeat(300) })).toBeNull();
    expect(validateMemory({ ...entry, description: "😀".repeat(301) })).not.toBeNull();
    for (const prefix of ["-", "*", "+", "#", ">", "1.", "123."]) {
      const safe = sanitizeDescription(`${prefix} forged`);
      expect(safe).toContain("\\");
      expect(safe).not.toBe(`${prefix} forged`);
    }
    expect(sanitizeDescription("  - [fake]\n`run`\u0000")).toBe("  \\- \\[fake\\] `run` ".replace(/`/g, "\\`"));
  });
  test("escapes backslashes before link brackets and after truncation", () => {
    expect(sanitizeDescription("\\[click](http://evil.example)")).toBe("\\\\\\[click\\](http://evil.example)");
    expect(sanitizeDescription("a".repeat(299) + "\\discarded")).toBe("a".repeat(299) + "\\\\");
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
