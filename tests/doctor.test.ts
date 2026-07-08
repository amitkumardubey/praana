import { describe, it, expect } from "bun:test";
import { handleDoctor } from "../src/doctor.js";
import type { PraanaConfig } from "../src/types.js";

const baseConfig: PraanaConfig = {
  llm: { provider: "ollama", model: "llama3" },
  memory: { enabled: false },
  compiler: { token_budget: 100000 },
  tiers: {},
  session: { log_dir: "/tmp/praana-test-sessions" },
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
});
