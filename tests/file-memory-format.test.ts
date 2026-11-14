import { describe, expect, test } from "bun:test";
import { MEMORY_NAME_SCHEMA_PATTERN, parseMemory, sanitizeDescription, serializeMemory, validName, validateMemory } from "../src/file-memory/format.js";

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
  test("the published name pattern is the plain slug while the validator keeps the reserved names", () => {
    const published = new RegExp(MEMORY_NAME_SCHEMA_PATTERN.source);
    expect(published.source).toBe("^[a-z0-9][a-z0-9-]{0,63}$");
    // No lookahead: a structured-output validator may reject one.
    expect(published.source).not.toContain("?!");
    const names: Array<[string, boolean]> = [
      ["coffee", true], ["a", true], ["a-b-c", true], ["note-1", true], ["0-start", true],
      // Neighbours of the reserved set are ordinary names.
      ["com0", true], ["lpt0", true], ["memorys", true], ["console", true], ["nullable", true],
      ["a".repeat(64), true],
      // Reserved device and index names keep their execution-time refusal in validName.
      ["memory", false], ["con", false], ["prn", false], ["aux", false], ["nul", false],
      ["com1", false], ["com9", false], ["lpt1", false], ["lpt9", false],
      ["Upper", false], ["Coffee", false], ["-lead", false], ["trail-", true], ["under_score", false],
      ["two words", false], ["", false], ["a".repeat(65), false],
      ["coffee\n", false], ["coffee\r\n", false], ["memory\n", false], ["con\n", false],
    ];
    // Both rules are consulted at execution, so a name is accepted only when the published
    // shape and the validator agree.
    for (const [name, accepted] of names) expect([name, published.test(name) && validName(name)]).toEqual([name, accepted]);
    // The published pattern itself is exactly the slug shape, so it accepts reserved names
    // that the validator refuses and nothing the validator would allow.
    for (const reserved of ["memory", "con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
      expect([reserved, published.test(reserved), validName(reserved)]).toEqual([reserved, true, false]);
    }
    for (const name of ["coffee", "note-1", "a", "a".repeat(64)]) expect([name, published.test(name)]).toEqual([name, validName(name)]);
    expect(validName("coffee\n")).toBe(false);
    expect(published.test("memory\n")).toBe(false);
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
