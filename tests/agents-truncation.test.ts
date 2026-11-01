import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentsContext, isAgentsTruncationNotice, AGENTS_TRUNCATION_MARKER, AGENTS_TRUNCATION_LOG_LINE } from "../src/session.js";
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
    const loaded = loadAgentsContext(cwd);
    expect(loaded).toBeTruthy();
    expect(loaded!.length).toBeLessThan(LONG_AGENTS.length);
    expect(loaded).toContain("<!-- [truncated] -->");
  });

  it("routes the raw notice through captureNotice instead of stderr when provided", () => {
    writeFileSync(join(cwd, "AGENTS.md"), LONG_AGENTS, "utf-8");
    const captured: string[] = [];
    const logger = new PraanaLogger({
      domain: "session",
      captureNotice: (line) => captured.push(line),
      suppressStderr: true,
    });
    loadAgentsContext(cwd, { logger });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("[session]");
    expect(captured[0]).toContain("AGENTS.md content truncated to ~4000 tokens");
  });

  it("does not call captureNotice when nothing was truncated", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "short instructions\n", "utf-8");
    const captured: string[] = [];
    const logger = new PraanaLogger({
      domain: "session",
      captureNotice: (line) => captured.push(line),
      suppressStderr: true,
    });
    const loaded = loadAgentsContext(cwd, { logger });
    expect(loaded).toContain("short instructions");
    expect(captured).toHaveLength(0);
  });

  it("the shared consumer predicate matches what the producer emits", () => {
    writeFileSync(join(cwd, "AGENTS.md"), LONG_AGENTS, "utf-8");
    const captured: string[] = [];
    const logger = new PraanaLogger({
      domain: "session",
      captureNotice: (line) => captured.push(line),
      suppressStderr: true,
    });
    loadAgentsContext(cwd, { logger });
    expect(captured).toHaveLength(1);
    expect(isAgentsTruncationNotice(captured[0])).toBe(true);
    expect(captured[0]).toContain(AGENTS_TRUNCATION_MARKER);
  });

  it("rewording the producer notice is caught by the shared constant", () => {
    // The capture line is composed from the same constant the consumer's
    // predicate matches on, so a rewording propagates to both sides.
    expect(AGENTS_TRUNCATION_LOG_LINE).toContain(AGENTS_TRUNCATION_MARKER);
    expect(isAgentsTruncationNotice(AGENTS_TRUNCATION_LOG_LINE)).toBe(true);
    // Unrelated log lines are not truncation notices.
    expect(isAgentsTruncationNotice("[session] context 1200 tok")).toBe(false);
    expect(isAgentsTruncationNotice("")).toBe(false);
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

describe("loadAgentsContext doc attachment", () => {
  it("the load-order/16000-char doc comment stays attached to the function", () => {
    const src = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
    const decl = "export function loadAgentsContext(";
    const fnIdx = src.indexOf(decl);
    expect(fnIdx).toBeGreaterThan(-1);
    const prefix = src.slice(0, fnIdx);
    const decls = [...prefix.matchAll(/^export (?:function|const)\b/gm)];
    expect(decls.length).toBeGreaterThan(0);
    // Everything after the last exported declaration is the tail that should
    // contain the JSDoc describing loadAgentsContext — if another export slips
    // between the docs and the function, they detach and hover docs are lost.
    const afterLastDecl = prefix.slice(decls[decls.length - 1].index ?? 0);
    expect(afterLastDecl).toContain(
      "Load project context from AGENTS.md / CLAUDE.md files.",
    );
  });
});
