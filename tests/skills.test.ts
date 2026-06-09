import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRuntime } from "../src/skills/index.js";
import type { SkillsRuntimeConfig } from "../src/skills/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpBase: string;

function makeConfig(overrides: Partial<SkillsRuntimeConfig> & { searchPaths?: string[] } = {}): SkillsRuntimeConfig {
  return {
    enabled: true,
    max_token_budget_ratio: 0.2,
    active_skill_idle_turns: 5,
    warm_skill_eviction_turns: 20,
    max_depth: 6,
    searchPaths: [join(tmpBase, "skills")],
    ...overrides,
  };
}

function writeSkill(dir: string, name: string, description: string, body = "") {
  const md = `---
name: ${name}
description: ${description}
---

${body}
`;
  const path = join(dir, `${name}.md`);
  writeFileSync(path, md, "utf-8");
  return path;
}

beforeEach(() => {
  tmpBase = join(tmpdir(), `aria-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SKILL.md Parsing
// ---------------------------------------------------------------------------

describe("SKILL.md parsing", () => {
  it("parses frontmatter and body", () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    const path = writeSkill(skillsDir, "test-skill", "A test skill", "## Execution\n\ndo the thing");
    const content = SkillRuntime.parseFile(path);
    expect(content).not.toBeNull();
    expect(content!.name).toBe("test-skill");
    expect(content!.description).toBe("A test skill");
    expect(content!.body).toContain("## Execution");
  });

  it("returns null on missing frontmatter", () => {
    const p = join(tmpBase, "no-frontmatter.md");
    writeFileSync(p, "just text", "utf-8");
    expect(SkillRuntime.parseFile(p)).toBeNull();
  });

  it("returns null when file does not exist", () => {
    expect(SkillRuntime.parseFile(join(tmpBase, "nonexistent.md"))).toBeNull();
  });

  it("returns null on empty name", () => {
    const p = join(tmpBase, "empty-name.md");
    writeFileSync(p, "---\nname: \ndescription: test\n---\n\nbody", "utf-8");
    expect(SkillRuntime.parseFile(p)).toBeNull();
  });

  it("returns null on empty description", () => {
    const p = join(tmpBase, "no-desc.md");
    writeFileSync(p, "---\nname: test\ndescription: \n---\n\nbody", "utf-8");
    expect(SkillRuntime.parseFile(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discovery", () => {
  it("discovers skills", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "alpha", "First skill");
    writeSkill(skillsDir, "beta", "Second skill");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    expect(rt.getSkillCount()).toBe(2);
  });

  it("returns 0 when disabled", async () => {
    const rt = new SkillRuntime({ ...makeConfig(), enabled: false }, tmpBase);
    await rt.initialize();
    expect(rt.getSkillCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Residency
// ---------------------------------------------------------------------------

describe("residency lifecycle", () => {
  it("all skills start COLD", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "alpha", "First skill");
    writeSkill(skillsDir, "beta", "Second skill");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    const counts = rt.getResidencyCounts();
    expect(counts.hot).toBe(0);
    expect(counts.warm).toBe(0);
    expect(counts.cold).toBe(2);
  });

  it("matching promotes to HOT", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations and commands", "## Planner\n\nUse git for version control.\n\n## Execution\n\nRun git commands.");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("commit and push to git repo");
    rt.endTurn();
    const counts = rt.getResidencyCounts();
    expect(counts.hot).toBe(1);
    expect(counts.cold).toBe(0);
  });

  it("HOT skills have section content in prompt", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations", "## Planner\n\nPlan git workflow.\n\n## Execution\n\nRun git commands.\n\n## Recovery\n\nFix git issues.");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("how do I git rebase");
    rt.endTurn();

    const section = rt.buildPromptSection(5000);
    expect(section).toContain("## Loaded Skills");
    expect(section).toContain("git [HOT]");
    expect(section).toContain("Plan git");
  });

  it("non-matching stays COLD", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations", "## Planner\n\nUse git.");
    writeSkill(skillsDir, "docker", "Docker containers", "## Planner\n\nUse docker.");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("zzzzyyyy uncommon query");
    rt.endTurn();
    const counts = rt.getResidencyCounts();
    expect(counts.hot).toBe(0);
    expect(counts.warm).toBe(0);
    expect(counts.cold).toBe(2);

    const section = rt.buildPromptSection(5000);
    expect(section).toContain("### Available Skills");
    expect(section).toContain("**git**");
    expect(section).toContain("**docker**");
  });

  it("idle turns demote HOT to WARM", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "node", "Node.js development", "## Planner\n\nUse node.");

    const rt = new SkillRuntime(makeConfig({ active_skill_idle_turns: 2, warm_skill_eviction_turns: 5 }), tmpBase);
    await rt.initialize();

    // Match → HOT
    rt.processUserInput("node run");
    rt.endTurn();
    expect(rt.getResidencyCounts().hot).toBe(1);

    // One idle turn: stays HOT
    rt.processUserInput("unrelated");
    rt.endTurn();
    expect(rt.getResidencyCounts().hot).toBe(1);

    // Second idle turn: demoted to WARM
    rt.processUserInput("unrelated");
    rt.endTurn();
    expect(rt.getResidencyCounts().hot).toBe(0);
    expect(rt.getResidencyCounts().warm).toBe(1);
  });

  it("exact skill-name matches promote to HOT", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "bare", "Bare skill with no sections", "Use this exact-name skill.");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("bare");
    rt.endTurn();

    expect(rt.getResidencyCounts().hot).toBe(1);
    expect(rt.buildPromptSection(5000)).toContain("bare [HOT]");
  });
});

// ---------------------------------------------------------------------------
// Prompt Section Building
// ---------------------------------------------------------------------------

describe("buildPromptSection", () => {
  it("returns default message when no skills discovered", async () => {
    const rt = new SkillRuntime(makeConfig({ searchPaths: [join(tmpBase, "empty-skills")] }), tmpBase);
    await rt.initialize();
    expect(rt.getSkillCount()).toBe(0);
    const section = rt.buildPromptSection(5000);
    expect(section).toContain("## Loaded Skills");
    expect(section).toContain("(no skills loaded)");
  });

  it("returns empty when disabled", async () => {
    const rt = new SkillRuntime({ ...makeConfig(), enabled: false }, tmpBase);
    await rt.initialize();
    expect(rt.buildPromptSection(5000)).toBe("");
  });

  it("includes HOT skills in section", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations", "## Planner\n\nPlan git.\n\n## Execution\n\nRun git.");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("git commit");
    rt.endTurn();

    const section = rt.buildPromptSection(5000);
    expect(section).toContain("git [HOT]");
  });

  it("uses compiler token budget for enforcement, not a hardcoded base", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(tmpBase, ".aria"), { recursive: true });
    writeFileSync(
      join(tmpBase, ".aria", "skills-meta.json"),
      JSON.stringify({
        "big-a": { budget: { max_tokens: 8000 } },
        "big-b": { budget: { max_tokens: 8000 } },
      }),
      "utf-8",
    );

    const largeBody = "A".repeat(30_000);
    writeSkill(skillsDir, "big-a", "Big skill A", largeBody);
    writeSkill(skillsDir, "big-b", "Big skill B", largeBody);

    const rt = new SkillRuntime(makeConfig({ max_token_budget_ratio: 1.0 }), tmpBase);
    await rt.initialize();

    rt.setBudgetBase(20_000);
    rt.processUserInput("big-a big-b");
    expect(rt.getResidencyCounts().hot).toBe(2);

    rt.setBudgetBase(10_000);
    expect(rt.getResidencyCounts().hot).toBeLessThan(2);
  });

  it("respects token budget", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "test-skill", "Test skill", "## Planner\n\n" + "A".repeat(5000));

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("test");
    rt.endTurn();

    const small = rt.buildPromptSection(50);
    const estimatedTokens = Math.ceil(small.length / 4);
    expect(estimatedTokens).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

describe("telemetry", () => {
  it("emits skill_loaded events on matching", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations", "## Planner\n\nUse git.\n\n## Execution\n\nRun git.");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("git push");
    rt.endTurn();

    const events = rt.getEvents();
    const loaded = events.find((e) => e.type === "skill_loaded");
    expect(loaded).toBeDefined();
    expect(loaded!.skill_id).toBe("git");
  });

  it("emits demotion events on idle timeout", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "node", "Node.js development", "## Planner\n\nUse node.");

    const rt = new SkillRuntime(makeConfig({ active_skill_idle_turns: 3, warm_skill_eviction_turns: 5 }), tmpBase);
    await rt.initialize();

    // Match → HOT
    rt.processUserInput("node run");
    rt.endTurn();
    expect(rt.getResidencyCounts().hot).toBe(1);

    // One idle turn: stays HOT
    rt.processUserInput("unrelated");
    rt.endTurn();
    expect(rt.getResidencyCounts().hot).toBe(1);

    // Second idle turn: demoted to WARM (idle count = turnCount - lastActiveTurn)
    rt.processUserInput("unrelated");
    rt.endTurn();
    rt.processUserInput("unrelated");
    rt.endTurn();
    rt.processUserInput("unrelated");
    rt.endTurn();

    const events = rt.getEvents();
    const demotion = events.find((e) => e.type === "skill_demoted");
    expect(demotion).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles disabled config", async () => {
    const rt = new SkillRuntime({ ...makeConfig(), enabled: false }, tmpBase);
    await rt.initialize();
    expect(rt.getSkillCount()).toBe(0);
    expect(rt.isEnabled()).toBe(false);
    expect(rt.buildPromptSection(5000)).toBe("");
  });

  it("handles skills with no sections", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "bare", "Bare skill with no sections", "Use the whole skill body.");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.processUserInput("bare");
    rt.endTurn();
    const section = rt.buildPromptSection(5000);
    expect(section).toContain("bare [HOT]");
    expect(section).toContain("Use the whole skill body.");
  });
});

// ---------------------------------------------------------------------------
// Activation helper
// ---------------------------------------------------------------------------

describe("markSkillActive", () => {
  it("does nothing for unknown id", async () => {
    const rt = new SkillRuntime(makeConfig({ searchPaths: [join(tmpBase, "empty-skills")] }), tmpBase);
    await rt.initialize();
    const before = rt.getResidencyCounts();
    rt.markSkillActive("nonexistent");
    const after = rt.getResidencyCounts();
    expect(after.hot).toBe(before.hot);
    expect(after.cold).toBe(before.cold);
  });
});
