import { describe, it, expect } from "bun:test";
import { parseLooseJson } from "../src/memory/parse-loose-json.js";

describe("parseLooseJson", () => {
  // --- Valid input ---

  it("parses valid JSON object", () => {
    const result = parseLooseJson('{"key": "value"}');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
    expect(result.repaired).toBeUndefined();
  });

  it("parses valid JSON array", () => {
    const result = parseLooseJson('[{"kind": "fact", "content": "test"}]');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([{ kind: "fact", content: "test" }]);
  });

  it("handles strings containing braces correctly", () => {
    const result = parseLooseJson('{"content": "function() { return {}; }"}');
    expect(result.ok).toBe(true);
    expect((result.value as Record<string, string>).content).toBe("function() { return {}; }");
  });

  it("parses JSON with ``` inside a string value", () => {
    // Regression guard: a ``` inside a JSON string value must not be
    // mistaken for a code fence. The fence-stripping guard skips when
    // the trimmed input already starts with { or [.
    const result = parseLooseJson('{"content":"use ``` for code"}');
    expect(result.ok).toBe(true);
    expect((result.value as Record<string, string>).content).toBe("use ``` for code");
  });

  // --- Code fences ---

  it("parses code-fenced JSON", () => {
    const result = parseLooseJson('```json\n{"key": "value"}\n```');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
  });

  it("parses code-fenced JSON without language tag", () => {
    const result = parseLooseJson('```\n{"key": "value"}\n```');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
  });

  it("parses truncated code fence (opening without closing)", () => {
    const result = parseLooseJson('```json\n{"key": "value"}');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
  });

  // --- Leading/trailing prose ---

  it("parses JSON with leading prose", () => {
    const result = parseLooseJson('Here is the result:\n{"key": "value"}');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
  });

  it("parses JSON with trailing prose", () => {
    const result = parseLooseJson('{"key": "value"}\n\nThat was the result.');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
  });

  it("parses JSON wrapped in prose", () => {
    const result = parseLooseJson('Sure! Here you go:\n{"key": "value"}\nHope this helps!');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
  });

  it("parses JSON when leading prose contains braces", () => {
    // The first balanced substring ({ is prose }) is not valid JSON.
    // The parser must try the next candidate ({"key": "value"}) and succeed.
    const result = parseLooseJson('Here { is prose } then {"key": "value"}');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ key: "value" });
  });

  it("parses JSON when leading prose contains brackets", () => {
    const result = parseLooseJson('See [note 1] then [{"kind":"fact"}]');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([{ kind: "fact" }]);
  });

  // --- Truncated JSON (repair) ---

  it("repairs truncated JSON with unterminated string", () => {
    const result = parseLooseJson(
      '{"learnings": [{"kind": "fact", "content": "some truncated cont',
    );
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    const value = result.value as { learnings: Array<{ kind: string; content: string }> };
    expect(value.learnings[0].kind).toBe("fact");
    expect(value.learnings[0].content).toContain("some truncated cont");
  });

  it("repairs truncated JSON with missing closing braces", () => {
    const result = parseLooseJson(
      '{"confirmations": ["id1"], "contradictions": []',
    );
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    const value = result.value as { confirmations: string[]; contradictions: string[] };
    expect(value.confirmations).toEqual(["id1"]);
    expect(value.contradictions).toEqual([]);
  });

  it("repairs truncated JSON with unterminated string and missing braces", () => {
    const result = parseLooseJson(
      '{"learnings": [{"kind": "fact", "content": "valid"}, {"kind": "pattern", "content": "truncate',
    );
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    const value = result.value as { learnings: Array<{ kind: string; content: string }> };
    expect(value.learnings).toHaveLength(2);
    expect(value.learnings[0].content).toBe("valid");
    expect(value.learnings[1].content).toContain("truncate");
  });

  it("repairs truncated JSON with trailing comma", () => {
    const result = parseLooseJson(
      '{"confirmations": ["id1"],',
    );
    expect(result.ok).toBe(true);
    const value = result.value as { confirmations: string[] };
    expect(value.confirmations).toEqual(["id1"]);
  });

  it("repairs truncated JSON array", () => {
    const result = parseLooseJson(
      '[{"kind": "fact", "content": "valid"}, {"kind": "pattern", "content": "truncate',
    );
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    const value = result.value as Array<{ kind: string; content: string }>;
    expect(value).toHaveLength(2);
    expect(value[0].content).toBe("valid");
    expect(value[1].content).toContain("truncate");
  });

  it("repairs deeply nested truncated JSON", () => {
    const result = parseLooseJson(
      '{"a": {"b": {"c": [1, 2, {"d": "truncate',
    );
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    const value = result.value as { a: { b: { c: Array<unknown> } } };
    expect(value.a.b.c).toHaveLength(3);
  });

  it("repairs truncated JSON with escaped quote in unterminated string", () => {
    // The string value contains an escaped quote and is truncated before the
    // closing quote. The repair must track the escape state correctly and
    // not treat the escaped quote as a string delimiter.
    const input = JSON.stringify({ content: 'he said "hello' }).slice(0, -2);
    const result = parseLooseJson(input);
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    const value = result.value as { content: string };
    expect(value.content).toBe('he said "hello');
  });

  it("repairs truncated JSON with escaped quote followed by more content", () => {
    // After the escaped quote, there is more string content, then truncation.
    const input = JSON.stringify({ content: 'he said "hello" and then truncate' }).slice(0, -2);
    const result = parseLooseJson(input);
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    const value = result.value as { content: string };
    expect(value.content).toBe('he said "hello" and then truncate');
  });

  // --- Failure cases ---

  it("returns error for empty input", () => {
    const result = parseLooseJson("");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for whitespace-only input", () => {
    const result = parseLooseJson("   \n\t  ");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for total garbage", () => {
    const result = parseLooseJson("I'm sorry, I can't help with that.");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for input with no JSON structure", () => {
    const result = parseLooseJson("just some text, no braces or brackets");
    expect(result.ok).toBe(false);
  });

  it("includes raw byte length in error message", () => {
    const garbage = "This is not JSON at all.";
    const result = parseLooseJson(garbage);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(String(garbage.length));
  });

  it("returns error for non-string input", () => {
    const result = parseLooseJson(null as unknown as string);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
