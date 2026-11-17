/**
 * Per-call `read_file` output cap (#811).
 *
 * A read returns at most MAX_READ_LINES lines and at most 25% of the model's
 * context window in estimated tokens; a line longer than MAX_LINE_CHARS is cut.
 * Whenever anything was cut the result carries `truncated: true` and a `note`
 * naming the lines returned and the `offset` that reads the next part, while
 * `content` stays pure file lines (engine-mode artifacts rely on that).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSystemTools, MAX_LINE_CHARS, MAX_READ_LINES } from "../src/tools/system.js";

type ReadTools = ReturnType<typeof createSystemTools>;

let cwd: string;
let tools: ReadTools;

function readTools(overrides: Partial<Parameters<typeof createSystemTools>[0]> = {}): ReadTools {
  return createSystemTools({
    cwd,
    skills: [],
    skillRuntime: null,
    getCurrentTurn: () => 0,
    ...overrides,
  });
}

beforeEach(() => {
  // Under the isolated test home (`tests/helpers/isolated-home.ts`), so this
  // scratch dir never lands in a developer's real home.
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  cwd = mkdtempSync(join(homedir(), ".cache", "praana-read-cap-"));
  tools = readTools();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("read_file per-call cap (#811)", () => {
  it("returns a small file unchanged plus total_lines and no truncated key", async () => {
    writeFileSync(join(cwd, "hello.txt"), "Hello World");
    const result = await tools.read_file.execute({ path: "hello.txt" });
    expect(result).toEqual({ ok: true, content: "Hello World", total_lines: 1 });
    expect("truncated" in result).toBe(false);
  });

  it("keeps a whole read byte-identical and reports no phantom line for a trailing newline", async () => {
    writeFileSync(join(cwd, "two.txt"), "alpha\nbeta\n");
    const result = await tools.read_file.execute({ path: "two.txt" });
    expect(result).toEqual({ ok: true, content: "alpha\nbeta\n", total_lines: 2 });
  });

  it("returns an empty file without crashing", async () => {
    writeFileSync(join(cwd, "empty.txt"), "");
    const result = await tools.read_file.execute({ path: "empty.txt" });
    expect(result).toEqual({ ok: true, content: "", total_lines: 0 });
  });

  it("caps a 5000-line file at MAX_READ_LINES and pages to the end", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const fileBytes = lines.join("\n") + "\n";
    writeFileSync(join(cwd, "big.txt"), fileBytes);

    const first = (await tools.read_file.execute({ path: "big.txt" })) as any;
    expect(first.ok).toBe(true);
    expect(first.total_lines).toBe(5000);
    expect(first.truncated).toBe(true);
    expect(first.content.split("\n")).toHaveLength(MAX_READ_LINES);
    expect(first.content.split("\n")[0]).toBe("line 1");
    expect(first.content.split("\n").at(-1)).toBe("line 2000");
    expect(first.note).toContain("Returned lines 1-2000 of 5000");
    expect(first.note).toContain("offset=2001");
    // The note never leaks into `content`: engine artifacts store it as raw lines.
    expect(first.content).not.toContain("offset=");
    expect(first.content).not.toContain("Returned lines");

    const second = (await tools.read_file.execute({ path: "big.txt", offset: 2001 })) as any;
    expect(second.content.split("\n")[0]).toBe("line 2001");
    expect(second.content.split("\n").at(-1)).toBe("line 4000");
    expect(second.note).toContain("offset=4001");

    const third = (await tools.read_file.execute({ path: "big.txt", offset: 4001 })) as any;
    expect(third.content.split("\n")).toHaveLength(1001); // 1000 lines + trailing newline
    expect(third.content.startsWith("line 4001\n")).toBe(true);
    expect("truncated" in third).toBe(false);
    expect(third.total_lines).toBe(5000);

    expect([first, second, third].map((r) => r.content).join("\n")).toBe(fileBytes);
  });

  it("honours an explicit limit below the cap and caps one above it", async () => {
    writeFileSync(join(cwd, "ten.txt"), Array.from({ length: 10 }, (_, i) => `n${i + 1}`).join("\n") + "\n");

    const small = (await tools.read_file.execute({ path: "ten.txt", limit: 3 })) as any;
    expect(small.content).toBe("n1\nn2\nn3");
    expect("truncated" in small).toBe(false);
    expect(small.total_lines).toBe(10);

    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(cwd, "many.txt"), lines.join("\n") + "\n");
    const oversized = (await tools.read_file.execute({ path: "many.txt", limit: 2500 })) as any;
    expect(oversized.content.split("\n")).toHaveLength(MAX_READ_LINES);
    expect(oversized.truncated).toBe(true);
    expect(oversized.note).toContain("offset=2001");
  });

  it("caps by a quarter of the model's context window in estimated tokens", async () => {
    const line = "x".repeat(80); // 20 estimated tokens per line
    writeFileSync(join(cwd, "tokens.txt"), Array.from({ length: 3000 }, () => line).join("\n") + "\n");
    const windowed = readTools({ getContextWindowTokens: () => 4000 }); // 1000-token cap

    const result = (await windowed.read_file.execute({ path: "tokens.txt" })) as any;
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    // 21n - 1 <= 1000  =>  n = 47, so the next part starts at line 48.
    expect(result.content.split("\n")).toHaveLength(47);
    expect(result.note).toContain("Returned lines 1-47 of 3000");
    expect(result.note).toContain("offset=48");

    // Unknown window: the 100_000-token fallback (25_000-token cap) allows far more.
    const fallback = (await tools.read_file.execute({ path: "tokens.txt" })) as any;
    const fallbackLines = fallback.content.split("\n").length;
    expect(fallbackLines).toBeLessThan(MAX_READ_LINES);
    expect(fallbackLines).toBeGreaterThan(result.content.split("\n").length);
    expect(fallback.note).toContain(`Returned lines 1-${fallbackLines} of 3000`);
    expect(fallback.note).toContain(`offset=${fallbackLines + 1}`);
  });

  it("cuts a single 1 MB line with a marker and flags truncation", async () => {
    const size = 1024 * 1024;
    writeFileSync(join(cwd, "minified.js"), "a".repeat(size));
    const result = (await tools.read_file.execute({ path: "minified.js" })) as any;
    expect(result.total_lines).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.content).toBe(`${"a".repeat(MAX_LINE_CHARS)} … [line truncated, ${size} chars]`);
    expect(result.note).toContain("Returned lines 1-1 of 1");
    expect(result.note).not.toContain("offset=");
  });

  it("always returns at least one line even when it alone exceeds the token cap", async () => {
    const long = "y".repeat(1000); // 250 estimated tokens, under MAX_LINE_CHARS
    writeFileSync(join(cwd, "one-long.txt"), `${long}\n${long}\n`);
    const windowed = readTools({ getContextWindowTokens: () => 100 }); // 25-token cap

    const result = (await windowed.read_file.execute({ path: "one-long.txt" })) as any;
    expect(result.ok).toBe(true);
    expect(result.content).toBe(long);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("Returned lines 1-1 of 2");
    expect(result.note).toContain("offset=2");
  });

  it("does not count pages of a capped read as repeat reads", async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(cwd, "paged.txt"), lines.join("\n") + "\n");
    // Mirrors the session: the callback records the mtime the next read compares.
    const mtimes = new Map<string, number>();
    const repeats: Array<boolean | undefined> = [];
    const paged = readTools({
      getReadPathMtime: (absPath) => mtimes.get(absPath),
      onScorecardFileRead: (absPath, mtimeMs, countAsRepeat) => {
        repeats.push(countAsRepeat);
        if (mtimeMs !== undefined) mtimes.set(absPath, mtimeMs);
      },
    });

    await paged.read_file.execute({ path: "paged.txt", offset: 1 });
    await paged.read_file.execute({ path: "paged.txt", offset: 2001 });
    await paged.read_file.execute({ path: "paged.txt", offset: 4001 });
    // Every read is reported, so the path still counts as "read" for the
    // unread-edit validator, but only the second read at offset 1 is a repeat.
    expect(repeats).toEqual([false, false, false]);
    await paged.read_file.execute({ path: "paged.txt", offset: 1 });
    expect(repeats).toEqual([false, false, false, true]);
  });

  it("does not cut or report a long line past the cap", async () => {
    const lines = Array.from({ length: MAX_READ_LINES }, (_, i) => `line ${i + 1}`);
    lines.push("z".repeat(MAX_LINE_CHARS * 2));
    writeFileSync(join(cwd, "late-long.txt"), lines.join("\n") + "\n");

    const result = (await tools.read_file.execute({ path: "late-long.txt" })) as any;
    expect(result.total_lines).toBe(MAX_READ_LINES + 1);
    expect(result.truncated).toBe(true);
    expect(result.content.split("\n")).toHaveLength(MAX_READ_LINES);
    expect(result.content).not.toContain("line truncated");
    expect(result.note).not.toContain("cut at");
    expect(result.note).toContain("offset=2001");
  });

  it("cuts a long line without splitting a surrogate pair", async () => {
    // Index MAX_LINE_CHARS - 1 lands on the high half of an emoji's pair.
    writeFileSync(join(cwd, "emoji.txt"), `${'a'}${'\u{1F600}'.repeat(MAX_LINE_CHARS)}\n`);
    const result = (await tools.read_file.execute({ path: "emoji.txt" })) as any;

    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(result.content)).toBe(false);
    expect(result.content).toContain("… [line truncated,");
    expect(result.note).toContain("1 line cut at 2000 characters");
  });

  it("points at the shell for the rest of a cut line", async () => {
    writeFileSync(join(cwd, "long.txt"), `${'q'.repeat(MAX_LINE_CHARS + 10)}\n`);
    const result = (await tools.read_file.execute({ path: "long.txt" })) as any;
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("not available through read_file");
    expect(result.note).toContain("use the shell to read the rest of a cut line");
    expect(result.content).not.toContain("use the shell");
  });

  it("returns empty content for an offset past the end", async () => {
    writeFileSync(join(cwd, "short.txt"), "a\nb\nc\n");
    const result = await tools.read_file.execute({ path: "short.txt", offset: 5000 });
    expect(result).toEqual({ ok: true, content: "", total_lines: 3 });
  });
});
