import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentsContext } from "../src/session.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import { formatAgentsTruncationNotice, AGENTS_TRUNCATION_NOTICE_TEXT } from "../src/ui/tui/boot-summary.js";

/** ~1000 chars per line — 30 lines comfortably exceed the 16000-char cap. */
const LONG_LINE = "x".repeat(1000) + "\n";
const LONG_AGENTS = LONG_LINE.repeat(30);

describe("AGENTS.md truncation notice", () => {
  let cwd: string;
  let praanaHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "praana-agents-cwd-"));
    praanaHome = mkdtempSync(join(tmpdir(), "praana-agents-home-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "app", writeLine: () => {} }));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("truncates long project instructions and marks the cut", () => {
    writeFileSync(join(cwd, "AGENTS.md"), LONG_AGENTS, "utf-8");
    const loaded = loadAgentsContext(cwd, { captureNotice: () => {} });
    expect(loaded).toBeTruthy();
    expect(loaded!.length).toBeLessThan(LONG_AGENTS.length);
    expect(loaded).toContain("<!-- [truncated] -->");
  });

  it("routes the raw notice through captureNotice instead of stderr when provided", () => {
    writeFileSync(join(cwd, "AGENTS.md"), LONG_AGENTS, "utf-8");
    const captured: string[] = [];
    loadAgentsContext(cwd, { captureNotice: (line) => captured.push(line) });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("[session]");
    expect(captured[0]).toContain("AGENTS.md content truncated to ~4000 tokens");
  });

  it("does not call captureNotice when nothing was truncated", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "short instructions\n", "utf-8");
    const captured: string[] = [];
    const loaded = loadAgentsContext(cwd, { captureNotice: (line) => captured.push(line) });
    expect(loaded).toContain("short instructions");
    expect(captured).toHaveLength(0);
  });

  it("supports being called without captureNotice (headless fallback)", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "short instructions\n", "utf-8");
    const loaded = loadAgentsContext(cwd);
    expect(loaded).toContain("short instructions");
  });

  it("friendly surfacing copy is stable and user-facing", () => {
    expect(formatAgentsTruncationNotice()).toBe(
      "Project instructions (AGENTS.md) are long; using the first ~4000 tokens.",
    );
    expect(AGENTS_TRUNCATION_NOTICE_TEXT).toContain("AGENTS.md");
    expect(AGENTS_TRUNCATION_NOTICE_TEXT).not.toContain("logger");
  });
});
