/**
 * Tests for Solid Prompt pure helpers (history / paste / autocomplete).
 */
import { describe, it, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PromptHistory } from "../src/ui/tui/prompt/history.js";
import {
  expandPasteChips,
  formatPasteChip,
  normalizePasteText,
  shouldCollapsePaste,
} from "../src/ui/tui/prompt/paste.js";
import {
  applyAutocomplete,
  getAutocomplete,
  tokenAtCaret,
} from "../src/ui/tui/prompt/autocomplete.js";

describe("PromptHistory", () => {
  it("pushes and browses with up/down including draft restore", () => {
    const h = new PromptHistory();
    h.push("one");
    h.push("two");
    expect(h.up("draft")).toBe("two");
    expect(h.up("draft")).toBe("one");
    expect(h.down()).toBe("two");
    expect(h.down()).toBe("draft");
    expect(h.isBrowsing()).toBe(false);
  });

  it("ignores empty pushes", () => {
    const h = new PromptHistory();
    h.push("  ");
    expect(h.size()).toBe(0);
  });
});

describe("paste collapse", () => {
  it("normalizes CRLF", () => {
    expect(normalizePasteText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("collapses long or multi-line pastes", () => {
    expect(shouldCollapsePaste("a\nb\nc")).toBe(true);
    expect(shouldCollapsePaste("x".repeat(151))).toBe(true);
    expect(shouldCollapsePaste("short")).toBe(false);
  });

  it("expands chips from the store", () => {
    const store = new Map([["abc123", "line1\nline2\nline3"]]);
    const chip = formatPasteChip(3, "abc123");
    expect(expandPasteChips(`hello ${chip} world`, store)).toBe(
      "hello line1\nline2\nline3 world",
    );
  });
});

describe("autocomplete", () => {
  it("applies path completion without adding a space", () => {
    const { text, caret } = applyAutocomplete("cat ./RE", 4, 8, {
      label: "README.md",
      value: "./README.md",
    });
    expect(text).toBe("cat ./README.md");
    expect(caret).toBe("cat ./README.md".length);
  });

  it("lone slash returns no autocomplete (palette owns slash)", async () => {
    expect(await getAutocomplete("/", 1, process.cwd())).toBeNull();
  });

  it("tokenAtCaret extracts the active token", () => {
    expect(tokenAtCaret("say /he", 7)).toEqual({
      token: "/he",
      start: 4,
      end: 7,
    });
  });

  it("suggests files under cwd", async () => {
    const dir = join(process.cwd(), ".tmp-ac-test");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "alpha.ts"), "");
    await writeFile(join(dir, "beta.ts"), "");
    const token = "./.tmp-ac-test/al";
    const r = await getAutocomplete(token, token.length, process.cwd());
    expect(r).not.toBeNull();
    expect(r!.items.some((i) => i.label === "alpha.ts")).toBe(true);
  });
});
