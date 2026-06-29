import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRuntime, buildSkillMetadataCatalog } from "../src/skills/index.js";
import type { SkillsRuntimeConfig } from "../src/skills/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpBase: string;

function makeConfig(overrides: Partial<SkillsRuntimeConfig> & { searchPaths?: string[] } = {}): SkillsRuntimeConfig {
  return {
    enabled: true,
    max_token_budget_ratio: 0.2,
    max_loaded_skills: 3,
    stale_threshold_turns: 10,
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
  tmpBase = join(tmpdir(), `praana-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
// Metadata catalog
// ---------------------------------------------------------------------------

describe("buildSkillMetadataCatalog", () => {
  it("lists skills with load_skill reference", () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");
    const catalog = buildSkillMetadataCatalog([
      { name: "git", description: "Git operations", location: join(skillsDir, "git.md"), directory: skillsDir, body: "", metadata: { name: "git", description: "Git operations" } },
    ]);
    expect(catalog).toContain("## Available Skills");
    expect(catalog).toContain("load_skill(skill_id)");
    expect(catalog).toContain("**git**");
    expect(catalog).not.toContain("`"); // no raw paths in pull model
  });
});

// ---------------------------------------------------------------------------
// Load tracking
// ---------------------------------------------------------------------------

describe("trackLoad", () => {
  it("tracks a skill load and increments loadedCount", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.trackLoad("git", 1);
    expect(rt.getLoadedSkillStats().loadedCount).toBe(1);
    expect(rt.getLoadedSkillNames()).toEqual(["git"]);
  });

  it("increments reloadedCount on repeated loads", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.trackLoad("git", 1);
    rt.trackLoad("git", 2);
    expect(rt.getLoadedSkillStats().reloadedCount).toBe(1);

    const events = rt.drainEvents();
    const reloaded = events.find((e) => e.type === "skill_reloaded");
    expect(reloaded).toBeDefined();
    expect(reloaded!.reload_count).toBe(1);
  });

  it("counts reload after stale eviction when skill is loaded again", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");

    const rt = new SkillRuntime(makeConfig({ stale_threshold_turns: 5 }), tmpBase);
    await rt.initialize();
    rt.trackLoad("git", 1);
    rt.cleanupStaleSkills(10);
    expect(rt.getLoadedSkillNames()).toEqual([]);

    rt.trackLoad("git", 11);
    expect(rt.getLoadedSkillStats().reloadedCount).toBe(1);
    const scorecard = rt.getSkillScorecard();
    expect(scorecard.loaded).toBe(1);
    expect(scorecard.loadEvents).toBe(2);
    expect(scorecard.used).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Skill budget enforcement
// ---------------------------------------------------------------------------

describe("enforceSkillBudget", () => {
  it("evicts oldest skill when max_loaded_skills exceeded", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");
    writeSkill(skillsDir, "docker", "Docker containers");
    writeSkill(skillsDir, "node", "Node.js");

    const rt = new SkillRuntime(makeConfig({ max_loaded_skills: 2 }), tmpBase);
    await rt.initialize();
    rt.trackLoad("git", 1);
    rt.trackLoad("docker", 2);
    rt.trackLoad("node", 3); // exceeds budget, git evicted

    const events = rt.drainEvents();
    expect(rt.getLoadedSkillNames()).toEqual(["node", "docker"]);
    expect(events.some((e) => e.type === "skill_evicted" && e.skill_id === "git")).toBe(true);
    expect(rt.getLoadedSkillStats().loadedCount).toBe(3); // everLoaded
    expect(rt.getLoadedSkillStats().evictedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stale cleanup
// ---------------------------------------------------------------------------

describe("cleanupStaleSkills", () => {
  it("evicts skills older than stale_threshold_turns", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");

    const rt = new SkillRuntime(makeConfig({ stale_threshold_turns: 10 }), tmpBase);
    await rt.initialize();
    rt.trackLoad("git", 1);
    rt.cleanupStaleSkills(12); // 12 - 1 > 10
    expect(rt.getLoadedSkillNames()).toEqual([]);

    const events = rt.drainEvents();
    expect(events.some((e) => e.type === "skill_evicted" && e.skill_id === "git")).toBe(true);
  });

  it("does not evict within stale_threshold_turns", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");

    const rt = new SkillRuntime(makeConfig({ stale_threshold_turns: 10 }), tmpBase);
    await rt.initialize();
    rt.trackLoad("git", 1);
    rt.cleanupStaleSkills(11); // 11 - 1 = 10 (not > 10)
    expect(rt.getLoadedSkillNames()).toEqual(["git"]);
  });
});

// ---------------------------------------------------------------------------
// getLoadedSkillNames ordering
// ---------------------------------------------------------------------------

describe("getLoadedSkillNames", () => {
  it("returns most-recently-loaded first", async () => {
    const skillsDir = join(tmpBase, "skills");
    mkdirSync(skillsDir);
    writeSkill(skillsDir, "git", "Git operations");
    writeSkill(skillsDir, "docker", "Docker containers");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();
    rt.trackLoad("git", 1);
    rt.trackLoad("docker", 2);
    expect(rt.getLoadedSkillNames()).toEqual(["docker", "git"]);

    rt.trackLoad("git", 3); // reload refreshes order
    expect(rt.getLoadedSkillNames()).toEqual(["git", "docker"]);
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
  });
});
