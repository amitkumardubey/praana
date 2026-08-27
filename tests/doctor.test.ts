import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDoctor } from "../src/doctor.js";
import { getConfigWarnings } from "../src/config.js";
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

  it("treats missing transformers as a warning, not a failure", async () => {
    const result = await handleDoctor(baseConfig);
    const embedderLine = result.lines.find((l) => l.includes("embedder:"));
    expect(embedderLine).toBeDefined();
    if (embedderLine!.includes("not installed")) {
      expect(embedderLine).toContain("⚠");
      expect(embedderLine).toContain("keyword-only mode");
    }
    expect(result.success).toBe(true);
  });
});
