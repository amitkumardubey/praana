import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countPrintedWarnings, handleDoctor } from "../src/doctor.js";
import { getConfigWarnings, loadConfig } from "../src/config.js";
import type { PraanaConfig } from "../src/types.js";

const testLogDir = mkdtempSync(join(tmpdir(), "praana-test-sessions-doctor-"));
const baseConfig: PraanaConfig = {
  llm: { provider: "ollama", model: "llama3" },
  memory: { enabled: false },
  compiler: { token_budget: 100000 },
  tiers: {},
  session: { log_dir: testLogDir },
  consolidation: {},
  shell: {},
  edit: { confirm: false },
  skills: { enabled: false },
  ui: {},
  context_engine: { enabled: false },
  project_detection: { enabled: false },
  turn: { max_steps: 25 },
} as unknown as PraanaConfig;

describe("handleDoctor", () => {
  let praanaHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    getConfigWarnings(); // drain leftover warnings from other files
    prevHome = process.env.PRAANA_HOME;
    praanaHome = mkdtempSync(join(tmpdir(), "praana-doctor-home-"));
    process.env.PRAANA_HOME = praanaHome;
  });

  afterEach(() => {
    getConfigWarnings();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("reports success when provider and model are configured", async () => {
    const result = await handleDoctor(baseConfig);
    expect(result.success).toBe(true);
    expect(result.lines.some((l) => l.includes("provider: ollama"))).toBe(true);
    expect(result.lines.some((l) => l.includes("model: llama3"))).toBe(true);
  });

  it("reports failure when model is missing", async () => {
    const config = { ...baseConfig, llm: { ...baseConfig.llm, model: "" } };
    const result = await handleDoctor(config);
    expect(result.success).toBe(false);
    expect(result.lines.some((l) => l.includes("model: not set"))).toBe(true);
  });

  it("summary names the warning count when every check passed with warnings", async () => {
    const result = await handleDoctor(baseConfig);
    expect(result.success).toBe(true);
    const warningCount = countPrintedWarnings(result.lines);
    const summary = result.lines.at(-1)!;
    if (warningCount > 0) {
      expect(summary).toMatch(/^All checks passed \(\d+ warnings?\)\.$/);
      expect(summary).toContain(String(warningCount));
      expect(summary).toContain(warningCount === 1 ? "warning" : "warnings");
    } else {
      expect(summary).toBe("All checks passed.");
    }
  });

  it("summary stays failure-only when a check failed", async () => {
    const config = { ...baseConfig, llm: { ...baseConfig.llm, model: "" } };
    const result = await handleDoctor(config);
    expect(result.success).toBe(false);
    expect(result.lines.at(-1)).toBe("Some checks failed.");
  });

  it("treats missing embedder weights as a warning, not a failure", async () => {
    const result = await handleDoctor(baseConfig);
    const embedderLine = result.lines.find((l) => l.includes("embedder:"));
    expect(embedderLine).toBeDefined();
    expect(result.lines.some((l) => l.includes("native:"))).toBe(true);
    expect(result.lines.some((l) => l.includes("search:"))).toBe(true);
    expect(result.lines.some((l) => l.includes("vectors:"))).toBe(true);
    if (embedderLine!.startsWith("⚠")) {
      expect(embedderLine).toMatch(/keyword-only|weights not downloaded|addon missing|runtime missing/);
    }
    expect(result.success).toBe(true);
  });

  it("counts indented config warnings when they are the only warning lines", () => {
    expect(
      countPrintedWarnings([
        "  ⚠ Invalid memory.embedder, using default 'auto'",
        "  ⚠ Invalid compiler.token_budget, using default 100000",
      ]),
    ).toBe(2);
  });

  it("counts a mix of column-0 warnings and indented config warnings", () => {
    expect(
      countPrintedWarnings([
        "✓ provider: ollama",
        "⚠ embedder: runtime ready, weights not downloaded (Xenova/all-MiniLM-L6-v2)",
        "",
        "Configuration warnings:",
        "  ⚠ Invalid memory.embedder, using default 'auto'",
        "  ⚠ Invalid memory.summarizer 'nope', using 'disabled'",
        "",
      ]),
    ).toBe(3);
  });

  it("counts zero when no warning lines are printed", () => {
    expect(countPrintedWarnings(["✓ provider: ollama", "✓ model: llama3", ""])).toBe(0);
  });

  it("config warnings are indented and still fail the run", async () => {
    writeFileSync(
      join(praanaHome, "warn.toml"),
      '[memory]\nembedder = "nope"\nsummarizer = "nope"\n',
    );
    loadConfig(join(praanaHome, "warn.toml"));
    const result = await handleDoctor(baseConfig);
    const indented = result.lines.filter((l) => l.startsWith("  ⚠ "));
    expect(indented).toContain("  ⚠ Invalid memory.embedder, using default 'auto'");
    expect(indented).toContain(
      "  ⚠ Invalid memory.summarizer 'nope', using 'disabled'",
    );
    expect(result.success).toBe(false);
    expect(result.lines.at(-1)).toBe("Some checks failed.");
    expect(countPrintedWarnings(result.lines)).toBe(
      result.lines.filter((l) => l.trimStart().startsWith("⚠")).length,
    );
  });

  it("mixed unindented and indented warnings are both counted, and the run still fails", async () => {
    writeFileSync(
      join(praanaHome, "warn.toml"),
      '[memory]\nembedder = "nope"\nsummarizer = "nope"\n',
    );
    loadConfig(join(praanaHome, "warn.toml"));
    const result = await handleDoctor(baseConfig);
    const indented = result.lines.filter((l) => l.startsWith("  ⚠ "));
    const columnZero = result.lines.filter((l) => l.startsWith("⚠"));
    expect(indented.length).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(false);
    expect(result.lines.at(-1)).toBe("Some checks failed.");
    expect(countPrintedWarnings([...columnZero, ...indented])).toBe(
      columnZero.length + indented.length,
    );
  });

  it("with no config warnings the passing summary matches every printed warning", async () => {
    const result = await handleDoctor(baseConfig);
    expect(result.lines.some((l) => l.startsWith("  ⚠ "))).toBe(false);
    expect(result.success).toBe(true);
    const n = countPrintedWarnings(result.lines);
    const summary = result.lines.at(-1)!;
    if (n === 0) {
      expect(summary).toBe("All checks passed.");
    } else {
      expect(summary).toBe(
        `All checks passed (${n} warning${n === 1 ? "" : "s"}).`,
      );
    }
  });
});
