import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { getAppLogger } from "../logger.js";
import type {
  SkillMetadata,
  SkillRecord,
  SkillIndexEntry,
  SkillTelemetryEvent,
  SkillsRuntimeConfig,
  LoadedSkill,
  SkillEffect,
} from "./types.js";
import { hashString } from "../hash.js";

// ========================================================================
// Helpers
// ========================================================================

function findGitRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const SKIP_ALLOWLIST = new Set([".agents", ".praana", ".cursor", ".claude"]);

function shouldSkipDir(dirName: string): boolean {
  if (dirName === ".git" || dirName === "node_modules") return true;
  if (dirName.startsWith(".") && !SKIP_ALLOWLIST.has(dirName)) return true;
  return false;
}

// ========================================================================
// SKILL.md Parsing
// ========================================================================

export function parseSkillMdContent(content: string, filePath: string): SkillRecord | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) return null;

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(yamlBlock) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const name = String(parsed.name ?? "");
  const description = String(parsed.description ?? "");

  if (!name || !description) return null;

  const metadata: SkillMetadata = {
    name,
    description,
    license: parsed.license ? String(parsed.license) : undefined,
    compatibility: parsed.compatibility ? String(parsed.compatibility) : undefined,
    metadata: parsed.metadata as Record<string, string> | undefined,
    allowedTools: parsed["allowed-tools"] ? String(parsed["allowed-tools"]) : undefined,
  };

  return {
    name,
    description,
    location: filePath,
    directory: dirname(filePath),
    body,
    metadata,
    scope: "",
  };
}

export function parseSkillMdFile(filePath: string): SkillRecord | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseSkillMdContent(content, filePath);
  } catch {
    return null;
  }
}

// ========================================================================
// Discovery
// ========================================================================

function getSkillSearchPaths(cwd: string): string[] {
  const gitRoot = findGitRoot(cwd);
  const home = homedir();

  const projectPaths = [
    join(gitRoot, ".agents", "skills"),
    join(gitRoot, ".praana", "skills"),
    join(gitRoot, ".cursor", "skills"),
    join(gitRoot, "skills"),
  ];

  const userPaths = [
    join(home, ".agents", "skills"),
    join(home, ".praana", "skills"),
    join(home, ".claude", "skills"),
  ];

  return [...projectPaths, ...userPaths];
}

function scanSkillsDir(skillsDir: string, maxDepth: number): SkillRecord[] {
  if (!existsSync(skillsDir)) return [];

  const results: SkillRecord[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (shouldSkipDir(entry)) continue;

      const fullPath = join(dir, entry);

      const skillFile = join(fullPath, "SKILL.md");
      if (isDirectory(fullPath) && existsSync(skillFile)) {
        const skill = parseSkillMdFile(skillFile);
        if (skill) {
          if (skill.name !== entry) {
            getAppLogger().child("skills").warn(
              `Name mismatch: "${skill.name}" in ${skillFile}, directory is "${entry}"`,
            );
          }
          results.push(skill);
        }
        continue;
      }

      if (entry.endsWith(".md") && !isDirectory(fullPath)) {
        const skill = parseSkillMdFile(fullPath);
        if (skill) results.push(skill);
        continue;
      }

      if (isDirectory(fullPath)) {
        scan(fullPath, depth + 1);
      }
    }
  }

  scan(skillsDir, 0);
  return results;
}

export function discoverSkills(cwd: string, maxDepth = 6, _paths?: string[]): SkillRecord[] {
  if (_paths) {
    // Test / override paths: no scope context available — leave scope as "" (default from parser).
    const merged = new Map<string, SkillRecord>();
    for (const dir of _paths) {
      for (const skill of scanSkillsDir(dir, maxDepth)) {
        merged.set(skill.name, skill);
      }
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  const paths = getSkillSearchPaths(cwd);
  const projectPaths = paths.slice(0, 4);
  const userPaths = paths.slice(4);

  // Project scope is keyed on the git root so it stays stable across subdirs.
  const projectScope = `context:${hashString(findGitRoot(cwd))}`;

  const projectSkills = new Map<string, SkillRecord>();
  const userSkills = new Map<string, SkillRecord>();

  for (const dir of projectPaths) {
    for (const skill of scanSkillsDir(dir, maxDepth)) {
      if (!projectSkills.has(skill.name)) {
        projectSkills.set(skill.name, { ...skill, scope: projectScope });
      }
    }
  }

  for (const dir of userPaths) {
    for (const skill of scanSkillsDir(dir, maxDepth)) {
      if (!userSkills.has(skill.name)) {
        userSkills.set(skill.name, skill); // scope stays "" (global)
      }
    }
  }

  const merged = new Map<string, SkillRecord>(userSkills);
  for (const [name, skill] of projectSkills) {
    if (merged.has(name)) {
      getAppLogger().child("skills").warn(`"${name}" from project overrides user-level skill`);
    }
    merged.set(name, skill);
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Metadata-only skill catalog for the compiled prompt (both modes).
 * When `usefulness` is provided, skills are sorted descending by score
 * (stable sort — ties keep discovery order).
 */
export function buildSkillMetadataCatalog(
  records: SkillRecord[],
  usefulness?: Map<string, number>,
): string {
  if (records.length === 0) return "";

  const sorted = usefulness && usefulness.size > 0
    ? [...records].sort((a, b) => (usefulness.get(b.name) ?? 0.5) - (usefulness.get(a.name) ?? 0.5))
    : records;

  const lines = [
    "## Available Skills",
    "",
    "Load a skill with load_skill(skill_id) when it is relevant:",
    "",
  ];

  for (const skill of sorted) {
    lines.push(`- **${skill.name}**: ${skill.description}`);
  }

  return lines.join("\n");
}

// ========================================================================
// SkillRuntime — load tracker for engine mode
// ========================================================================

export class SkillRuntime {
  private config: SkillsRuntimeConfig;
  private cwd: string;

  // Core state
  private records: SkillRecord[] = [];
  private index: SkillIndexEntry[] = [];

  // Load tracking (engine mode only)
  private loadedSkills = new Map<string, LoadedSkill>();
  private everLoaded = new Set<string>();
  private totalReloads = 0;
  private totalEvictions = 0;

  // Used tracking: skills that had ≥1 non-load_skill tool call during residency.
  private usedSkills = new Set<string>();

  // Co-residency pairs — both resident at same turn-end snapshot.
  // Encoded as "a\x00b" with a < b lexicographically.
  private coResidencies = new Set<string>();

  // Skills-specific counters (for scorecard)
  private skillLoads = 0;
  private skillUnderloadEvents = 0;
  private skillTokensConsumed = 0;

  // Telemetry
  private events: SkillTelemetryEvent[] = [];

  constructor(config: SkillsRuntimeConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
  }

  /** Parse a SKILL.md file. Returns null if invalid or missing required fields. */
  static parseFile(filePath: string): SkillRecord | null {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    return parseSkillMdContent(content, filePath);
  }

  // ---- Initialization ----

  async initialize(): Promise<void> {
    if (!this.config.enabled) return;

    this.records = this.config.searchPaths
      ? discoverSkills(this.cwd, this.config.max_depth, this.config.searchPaths)
      : discoverSkills(this.cwd, this.config.max_depth);

    this.index = this.records.map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
      tags: [],
      location: s.location,
    }));
  }

  // ---- Load tracking ----

  /**
   * Track a skill load (called by the load_skill tool in ENGINE mode only).
   * The tool reads the file from disk; this method records the load + enforces budget.
   */
  trackLoad(skillId: string, currentTurn: number, tokens = 0): void {
    const existing = this.loadedSkills.get(skillId);
    if (existing) {
      existing.reloadCount++;
      existing.loadedTurn = currentTurn;
      this.totalReloads++;
      this.skillLoads++;
      this.emit({
        type: "skill_reloaded",
        skill_id: skillId,
        loaded_turn: currentTurn,
        reload_count: existing.reloadCount,
        timestamp: Date.now(),
      });
    } else if (this.everLoaded.has(skillId)) {
      this.loadedSkills.set(skillId, { skillId, loadedTurn: currentTurn, reloadCount: 0, used: false });
      this.totalReloads++;
      this.skillLoads++;
      this.emit({
        type: "skill_reloaded",
        skill_id: skillId,
        loaded_turn: currentTurn,
        reload_count: 0,
        timestamp: Date.now(),
      });
    } else {
      this.loadedSkills.set(skillId, { skillId, loadedTurn: currentTurn, reloadCount: 0, used: false });
      this.everLoaded.add(skillId);
      this.skillLoads++;
      this.emit({
        type: "skill_loaded",
        skill_id: skillId,
        loaded_turn: currentTurn,
        timestamp: Date.now(),
      });
    }
    if (tokens > 0) {
      this.addSkillTokens(tokens);
    }
    this.enforceSkillBudget();
  }

  /** Evict skills older than stale_threshold_turns. Called at turn end. */
  cleanupStaleSkills(currentTurn: number): void {
    for (const [id, skill] of this.loadedSkills) {
      if (currentTurn - skill.loadedTurn > this.config.stale_threshold_turns) {
        this.loadedSkills.delete(id);
        this.totalEvictions++;
        this.skillUnderloadEvents++;
        this.emit({
          type: "skill_evicted",
          skill_id: id,
          loaded_turn: skill.loadedTurn,
          timestamp: Date.now(),
        });
      }
    }
    this.recordCoResidencies();
  }

  /** Evict oldest-by-loadedTurn until <= max_loaded_skills. */
  private enforceSkillBudget(): void {
    while (this.loadedSkills.size > this.config.max_loaded_skills) {
      let oldest: LoadedSkill | null = null;
      for (const skill of this.loadedSkills.values()) {
        if (!oldest || skill.loadedTurn < oldest.loadedTurn) oldest = skill;
      }
      if (oldest) {
        this.loadedSkills.delete(oldest.skillId);
        this.totalEvictions++;
        this.emit({
          type: "skill_evicted",
          skill_id: oldest.skillId,
          loaded_turn: oldest.loadedTurn,
          timestamp: Date.now(),
        });
      }
    }
  }

  // ---- Used-signal tracking ----

  /**
   * Mark every currently-resident skill as used.
   * Called at turn end when ≥1 non-load_skill tool call ran during the turn.
   * Idempotent per skill per session.
   */
  markResidentSkillsUsed(): void {
    for (const [id, skill] of this.loadedSkills) {
      skill.used = true;
      this.usedSkills.add(id);
    }
  }

  /**
   * SkillEffect records for every skill ever loaded this session.
   * Used by SkillStatsStore.flush at session end.
   */
  getSkillEffects(): SkillEffect[] {
    const scopeMap = new Map<string, string>(this.records.map((r) => [r.name, r.scope]));
    const effects: SkillEffect[] = [];
    for (const id of this.everLoaded) {
      effects.push({
        skillId: id,
        scope: scopeMap.get(id) ?? "",
        loaded: true,
        used: this.usedSkills.has(id),
      });
    }
    return effects;
  }

  /**
   * Co-occurrence pairs (both resident at same turn-end snapshot), a < b.
   * Data-collection for a future ranking consumer; no boost applied this issue.
   */
  getCooccurrencePairs(): Array<[string, string]> {
    return [...this.coResidencies].map((key) => key.split("\x00") as [string, string]);
  }

  /** Snapshot currently-loaded pairs into coResidencies after eviction. */
  private recordCoResidencies(): void {
    const ids = [...this.loadedSkills.keys()].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        this.coResidencies.add(`${ids[i]}\x00${ids[j]}`);
      }
    }
  }

  // ---- Telemetry ----

  private emit(event: SkillTelemetryEvent): void {
    this.events.push(event);
  }

  drainEvents(): SkillTelemetryEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  getEvents(): SkillTelemetryEvent[] {
    return [...this.events];
  }

  // ---- Queries ----

  getIndex(): SkillIndexEntry[] {
    return [...this.index];
  }

  getSkillCount(): number {
    return this.index.length;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Currently-loaded skill names, most-recently-loaded first (status-bar display). */
  getLoadedSkillNames(): string[] {
    return [...this.loadedSkills.values()]
      .sort((a, b) => b.loadedTurn - a.loadedTurn)
      .map((s) => s.skillId);
  }

  /**
   * Session-end summary data for measurement_mode.
   */
  getLoadedSkillStats(): { catalogSize: number; loadedCount: number; reloadedCount: number; evictedCount: number } {
    return {
      catalogSize: this.records.length,
      loadedCount: this.everLoaded.size,
      reloadedCount: this.totalReloads,
      evictedCount: this.totalEvictions,
    };
  }

  /**
   * Scorecard counters for this session.
   * `used` is the real count of skills that had a tool call during residency.
   */
  getSkillScorecard(): {
    loaded: number;
    loadEvents: number;
    used: number;
    reloaded: number;
    evicted: number;
    underload: number;
    tokensConsumed: number;
    skillIds: string[];
  } {
    return {
      loaded: this.everLoaded.size,
      loadEvents: this.skillLoads,
      used: this.usedSkills.size,
      reloaded: this.totalReloads,
      evicted: this.totalEvictions,
      underload: this.skillUnderloadEvents,
      tokensConsumed: this.skillTokensConsumed,
      skillIds: [...this.everLoaded],
    };
  }

  /**
   * Add to the skill tokens consumed counter.
   */
  addSkillTokens(tokens: number): void {
    this.skillTokensConsumed += tokens;
  }
}
