import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { getAppLogger } from "../logger.js";
import type {
  SkillMetadata,
  SkillRecord,
  SkillBudgetConfig,
  SkillAriaMeta,
  SkillsMetaFile,
  SkillIndexEntry,
  SkillRuntimeState,
  SkillRuntimeSnapshot,
  SkillResidency,
  SkillSection,
  SkillTelemetryEvent,
  SkillsRuntimeConfig,
  SkillSectionMapping,
} from "./types.js";

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

const SKIP_ALLOWLIST = new Set([".agents", ".aria", ".praana", ".cursor", ".claude"]);

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
// skills-meta.json Loading
// ========================================================================

function loadSkillsMeta(path: string): SkillsMetaFile {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as SkillsMetaFile;
  } catch {
    return {};
  }
}

function getSkillsMetaPaths(cwd: string): string[] {
  const gitRoot = findGitRoot(cwd);
  const home = homedir();
  return [
    join(gitRoot, ".praana", "skills-meta.json"),
    join(gitRoot, ".aria", "skills-meta.json"),
    expandHome("~/.praana/skills-meta.json"),
    expandHome("~/.aria/skills-meta.json"),
  ];
}

export function loadMergedSkillsMeta(cwd: string): SkillsMetaFile {
  let merged: SkillsMetaFile = {};
  for (const path of getSkillsMetaPaths(cwd)) {
    merged = { ...merged, ...loadSkillsMeta(path) };
  }
  return merged;
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
    join(gitRoot, ".aria", "skills"),
    join(gitRoot, ".cursor", "skills"),
    join(gitRoot, "skills"),
  ];

  const userPaths = [
    join(home, ".agents", "skills"),
    join(home, ".praana", "skills"),
    join(home, ".aria", "skills"),
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

  const projectSkills = new Map<string, SkillRecord>();
  const userSkills = new Map<string, SkillRecord>();

  for (const dir of projectPaths) {
    for (const skill of scanSkillsDir(dir, maxDepth)) {
      if (!projectSkills.has(skill.name)) projectSkills.set(skill.name, skill);
    }
  }

  for (const dir of userPaths) {
    for (const skill of scanSkillsDir(dir, maxDepth)) {
      if (!userSkills.has(skill.name)) userSkills.set(skill.name, skill);
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

/** Metadata-only skill catalog for classic mode (no residency or BM25). */
export function buildSkillMetadataCatalog(records: SkillRecord[]): string {
  if (records.length === 0) return "";

  const lines = [
    "## Available Skills",
    "",
    "Read a skill with read_file when it is relevant:",
    "",
  ];

  for (const skill of records) {
    lines.push(`- **${skill.name}**: ${skill.description} (\`${skill.location}\`)`);
  }

  return lines.join("\n");
}

// ========================================================================
// Section Boundary Detection
// ========================================================================

function detectSectionRanges(
  body: string,
  ariaSections?: SkillSectionMapping,
): Record<string, { start: number; end: number }> | undefined {
  if (!body) return undefined;

  const ranges: Record<string, { start: number; end: number }> = {};
  const lines = body.split("\n");
  let hasAny = false;

  // Use aria.skill.json section headings if provided, else auto-detect
  const sectionDefs = ariaSections ?? {
    planner: ["## Planner"],
    execution: ["## Execution"],
    recovery: ["## Recovery"],
    examples: ["## Examples"],
  };

  for (const [section, headings] of Object.entries(sectionDefs)) {
    // Find the first heading match for this section
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      for (const h of headings) {
        if (lines[i].trim().startsWith(h)) {
          startIdx = i;
          break;
        }
      }
      if (startIdx >= 0) break;
    }
    if (startIdx < 0) continue;

    // Find the next heading or end of body
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("## ")) {
        endIdx = i;
        break;
      }
    }

    ranges[section] = { start: startIdx, end: endIdx };
    hasAny = true;
  }

  return hasAny ? ranges : undefined;
}

function extractSection(body: string, range: { start: number; end: number } | undefined): string {
  if (!range || !body) return "";
  const lines = body.split("\n");
  return lines.slice(range.start, range.end).join("\n").trim();
}

// ========================================================================
// BM25 Matcher
// ========================================================================

// Default synonym map for V1
const DEFAULT_SYNONYMS: Record<string, string[]> = {
  deploy: ["launch", "release", "rollout", "publish"],
  database: ["db", "postgres", "mysql", "sql", "rds", "dynamodb"],
  container: ["docker", "ecs", "kubernetes", "k8s", "pod"],
  aws: ["amazon", "ec2", "s3", "lambda", "cloud"],
  test: ["testing", "spec", "assert", "verify", "check"],
  build: ["compile", "bundle", "package", "construct"],
  error: ["error", "failure", "bug", "issue", "crash", "exception"],
  fix: ["fix", "repair", "patch", "resolve", "correct"],
  code: ["code", "source", "implementation", "program"],
  review: ["review", "audit", "inspect", "check"],
  config: ["configuration", "setup", "settings", "options"],
  monitor: ["monitoring", "observe", "watch", "track", "metrics"],
  auth: ["authentication", "login", "oauth", "sso", "identity"],
  api: ["rest", "graphql", "endpoint", "service", "http"],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function expandTokens(tokens: string[], synonymMap: Record<string, string[]>): string[] {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const syns = synonymMap[t];
    if (syns) for (const s of syns) expanded.add(s);
  }
  return [...expanded];
}

export function buildBM25Index(
  skills: SkillRecord[],
  meta: SkillsMetaFile,
): SkillIndexEntry[] {
  return skills.map((s) => {
    const aria = meta[s.name] ?? {};
    const tags = aria.tags ?? [];
    const trigger = aria.trigger ?? "";
    const synonyms = aria.synonyms ?? [];

    // Build search text from name, description, tags, trigger
    const searchParts = [s.name, s.description, ...tags, trigger, ...synonyms];
    const searchText = searchParts.filter(Boolean).join(" ");

    const budgetConfig: SkillBudgetConfig = aria.budget ?? {};
    const sectionMapping = aria.sections;

    return {
      id: s.name,
      name: s.name,
      description: s.description,
      tags,
      trigger,
      synonyms,
      neighbors: aria.neighbors ?? [],
      searchText,
      sectionRanges: detectSectionRanges(s.body, sectionMapping),
      budgetPriority: budgetConfig.priority ?? "normal",
      maxTokens: budgetConfig.max_tokens ?? 2000,
    };
  });
}

/** Score a single query against a document using BM25 */
function bm25Score(queryTokens: string[], docTokens: string[], avgDocLen: number, totalDocs: number, docFreq: Map<string, number>): number {
  const k1 = 1.5;
  const b = 0.75;
  const docLen = docTokens.length;

  // Count term frequencies in this document
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    const freq = tf.get(qt) ?? 0;
    if (freq === 0) continue;

    const df = docFreq.get(qt) ?? 1;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docLen / avgDocLen));
    score += idf * (numerator / denominator);
  }

  return score;
}

export interface MatchResult {
  entry: SkillIndexEntry;
  score: number;
}

/**
 * Rank skills by relevance to user input using BM25 + synonym expansion + neighbor boost.
 */
export function rankSkills(
  index: SkillIndexEntry[],
  userInput: string,
  hotSkillIds: Set<string>,
  synonymMap?: Record<string, string[]>,
): MatchResult[] {
  if (index.length === 0 || !userInput.trim()) return [];

  const syns = synonymMap ?? DEFAULT_SYNONYMS;
  const queryTokens = expandTokens(tokenize(userInput), syns);
  if (queryTokens.length === 0) return [];

  // Build document frequency map across corpus
  const docFreq = new Map<string, number>();
  const docTokenLists: string[][] = [];

  for (const entry of index) {
    const tokens = tokenize(entry.searchText);
    docTokenLists.push(tokens);
    const unique = new Set(tokens);
    for (const t of unique) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const totalDocs = index.length;
  const avgDocLen = docTokenLists.reduce((sum, t) => sum + t.length, 0) / Math.max(1, totalDocs);

  const results: MatchResult[] = [];

  for (let i = 0; i < index.length; i++) {
    const entry = index[i];
    const docTokens = docTokenLists[i];
    let score = bm25Score(queryTokens, docTokens, avgDocLen, totalDocs, docFreq);

    // Keyword score bonus (0.5 weight): fraction of unique doc tokens that match query
    const querySet = new Set(queryTokens);
    const docSet = new Set(docTokens);
    const overlap = [...querySet].filter((t) => docSet.has(t)).length;
    const keywordScore = docSet.size > 0 ? overlap / docSet.size : 0;
    score = score * 0.3 + keywordScore * 0.5;

    // Name match bonus: if the skill name appears in the query, add +0.25
    const nameTokens = tokenize(entry.name);
    const nameMatch = nameTokens.some((nt) => querySet.has(nt));
    if (nameMatch) score += 0.25;

    // Exact skill invocation should load the skill, even when the corpus is
    // tiny and BM25/keyword scoring would otherwise leave it WARM.
    if (userInput.trim().toLowerCase() === entry.name.toLowerCase()) {
      score = Math.max(score, 0.5);
    }

    // Graph neighbor boost (0.2 weight): boost if this skill is neighbor of a hot skill
    let graphBoost = 0;
    for (const hotId of hotSkillIds) {
      const hotEntry = index.find((e) => e.id === hotId);
      if (hotEntry?.neighbors?.includes(entry.id)) {
        graphBoost = 0.2;
        break;
      }
    }
    score += graphBoost * 0.2;

    if (score > 0) {
      results.push({ entry, score });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ========================================================================
// Neighbor Discovery
// ========================================================================

function getNeighborIds(entry: SkillIndexEntry): string[] {
  return entry.neighbors ?? [];
}

// ========================================================================
// SkillRuntime
// ========================================================================

export class SkillRuntime {
  private config: SkillsRuntimeConfig;
  private cwd: string;

  // Core state
  private records: SkillRecord[] = [];
  private index: SkillIndexEntry[] = [];
  private runtimeStates = new Map<string, SkillRuntimeState>();
  private turnCount = 0;

  // Telemetry
  private events: SkillTelemetryEvent[] = [];

  // Token budget base (set from compiler.token_budget each turn)
  private budgetBase = 100_000;

  // Synonym map (extendable)
  private synonyms: Record<string, string[]> = { ...DEFAULT_SYNONYMS };

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

    // 1. Discover skills
    this.records = this.config.searchPaths
      ? discoverSkills(this.cwd, this.config.max_depth, this.config.searchPaths)
      : discoverSkills(this.cwd, this.config.max_depth);

    // 2. Load ARIA-specific metadata
    const meta = loadMergedSkillsMeta(this.cwd);

    // 3. Merge user-provided synonyms from meta (extensible)
    // (no field for custom synonyms yet — future)

    // 4. Build BM25 index
    this.index = buildBM25Index(this.records, meta);

    // 5. Emit discovery events
    for (const entry of this.index) {
      this.emit({
        type: "skill_discovered",
        skill_id: entry.id,
        timestamp: Date.now(),
      });

      // Initialize all skills as cold
      this.runtimeStates.set(entry.id, {
        entry,
        residency: "cold",
        loadedSections: [],
        lastActiveTurn: 0,
        tokenCost: 0,
        body: this.records.find((r) => r.name === entry.id)?.body ?? "",
        directory: this.records.find((r) => r.name === entry.id)?.directory ?? "",
      });
    }
  }

  // ---- Per-turn processing ----

  processUserInput(userInput: string): void {
    if (!this.config.enabled || this.index.length === 0) return;

    // 1. Get currently hot skill IDs
    const hotIds = new Set<string>();
    for (const [id, state] of this.runtimeStates) {
      if (state.residency === "hot") hotIds.add(id);
    }

    // 2. Rank skills against user input
    const matches = rankSkills(this.index, userInput, hotIds, this.synonyms);

    // 3. Promote top matches to HOT (up to budget)
    // Determine which skills get promoted
    const promoteToHot: string[] = [];
    const promoteToWarm: string[] = [];

    for (const match of matches) {
      const state = this.runtimeStates.get(match.entry.id);
      if (!state) continue;

      if (match.score >= 0.3 && state.residency === "cold") {
        promoteToWarm.push(match.entry.id);
      }
      if (match.score >= 0.5) {
        promoteToHot.push(match.entry.id);
      }

      this.emit({
        type: "skill_matched",
        skill_id: match.entry.id,
        score: Math.round(match.score * 100) / 100,
        residency: state.residency,
        timestamp: Date.now(),
      });
    }

    // 4. Apply neighbor boosting
    for (const hotId of promoteToHot) {
      const hotState = this.runtimeStates.get(hotId);
      if (!hotState) continue;
      for (const nid of getNeighborIds(hotState.entry)) {
        const nState = this.runtimeStates.get(nid);
        if (nState && nState.residency === "cold") {
          promoteToWarm.push(nid);
          this.emit({
            type: "skill_neighbor_boosted",
            skill_id: nid,
            residency: "warm",
            timestamp: Date.now(),
          });
        }
      }
    }

    // 5. Apply residency changes
    for (const id of promoteToHot) {
      this.setResidency(id, "hot");
    }
    for (const id of promoteToWarm) {
      if (this.runtimeStates.get(id)?.residency === "cold") {
        this.setResidency(id, "warm");
      }
    }

    // 6. Enforce token budget
    this.enforceBudget();
  }

  endTurn(): void {
    if (!this.config.enabled) return;

    // 1. Update turn count
    this.turnCount++;

    // 2. Demote idle hot → warm
    for (const [id, state] of this.runtimeStates) {
      if (state.residency !== "hot") continue;
      const idle = Math.max(0, this.turnCount - state.lastActiveTurn - 1);
      if (idle >= this.config.active_skill_idle_turns) {
        this.demote(id, "warm");
      }
    }

    // 3. Evict idle warm → cold
    for (const [id, state] of this.runtimeStates) {
      if (state.residency !== "warm") continue;
      const idle = Math.max(0, this.turnCount - state.lastActiveTurn - 1);
      if (idle >= this.config.warm_skill_eviction_turns) {
        this.evict(id);
      }
    }
  }

  markSkillActive(skillId: string): void {
    const state = this.runtimeStates.get(skillId);
    if (state) {
      state.lastActiveTurn = this.turnCount;
    }
  }

  // ---- Prompt assembly ----

  getSnapshot(tokenBudget: number): SkillRuntimeSnapshot {
    const hot: SkillRuntimeState[] = [];
    const warm: SkillRuntimeState[] = [];
    let tokenUsage = 0;

    for (const state of this.runtimeStates.values()) {
      if (state.residency === "hot") {
        hot.push(state);
        tokenUsage += state.tokenCost;
      } else if (state.residency === "warm") {
        warm.push(state);
      }
    }

    return {
      hot: hot.sort((a, b) => a.entry.name.localeCompare(b.entry.name)),
      warm: warm.sort((a, b) => a.entry.name.localeCompare(b.entry.name)),
      tokenUsage,
      tokenBudget,
    };
  }

  /** Build the skills section for the compiled prompt. */
  buildPromptSection(tokenBudget: number): string {
    if (!this.config.enabled) return "";
    // Enforce budget before building
    this.setBudgetBase(tokenBudget);
    const snapshot = this.getSnapshot(tokenBudget);
    const lines: string[] = ["## Loaded Skills"];

    if (snapshot.hot.length === 0 && snapshot.warm.length === 0) {
      const cold = [...this.runtimeStates.values()]
        .filter((s) => s.residency === "cold")
        .sort((a, b) => a.entry.name.localeCompare(b.entry.name));

      if (cold.length === 0) {
        lines.push("", "(no skills loaded)");
        return lines.join("\n");
      }

      lines.push("", "### Available Skills");
      for (const state of cold) {
        lines.push(`- **${state.entry.name}**: ${state.entry.description}`);
      }
      return lines.join("\n");
    }

    // HOT skills — full bodies of loaded sections
    for (const state of snapshot.hot) {
      lines.push("", `### ${state.entry.name} [HOT]`);
      lines.push(`Tags: ${state.entry.tags.join(", ") || "(none)"}`);
      if (state.entry.trigger) lines.push(`Trigger: ${state.entry.trigger}`);

      // Progressive sections
      for (const section of state.loadedSections) {
        const sectionContent = this.getSectionContent(state, section);
        if (sectionContent) {
          lines.push("", sectionContent);
        }
      }

      // If no sections loaded, load full body
      if (state.loadedSections.length === 0 && state.body) {
        lines.push("", state.body);
      }
    }

    // WARM skills — one-line stubs
    if (snapshot.warm.length > 0) {
      lines.push("", "### Standing By");
      for (const state of snapshot.warm) {
        const tags = state.entry.tags.length > 0 ? ` [${state.entry.tags.slice(0, 3).join(", ")}]` : "";
        lines.push(`- ${state.entry.name}${tags}`);
      }
    }

    return lines.join("\n");
  }

  private getSectionContent(state: SkillRuntimeState, section: SkillSection): string {
    if (!state.entry.sectionRanges) return "";
    const range = state.entry.sectionRanges[section];
    if (!range) return "";
    return extractSection(state.body, range);
  }

  // ---- Residency management ----

  private setResidency(id: string, target: SkillResidency): void {
    const state = this.runtimeStates.get(id);
    if (!state || state.residency === target) return;

    const prev = state.residency;
    state.residency = target;
    state.lastActiveTurn = this.turnCount;

    if (target === "hot") {
      // Progressive hydration: load planner first, execution on active use
      this.hydrateSkill(id);
    }

    if (target === "hot") {
      this.emit({
        type: "skill_loaded",
        skill_id: id,
        residency: target,
        prev_residency: prev,
        sections: state.loadedSections,
        token_cost: state.tokenCost,
        timestamp: Date.now(),
      });
    } else {
      this.emit({
        type: "skill_promoted",
        skill_id: id,
        residency: target,
        prev_residency: prev,
        sections: state.loadedSections,
        token_cost: state.tokenCost,
        timestamp: Date.now(),
      });
    }
  }

  private demote(id: string, target: "warm" | "cold"): void {
    const state = this.runtimeStates.get(id);
    if (!state) return;

    const prev = state.residency;
    state.residency = target;
    state.loadedSections = [];
    state.tokenCost = 0;

    this.emit({
      type: "skill_demoted",
      skill_id: id,
      residency: target,
      prev_residency: prev,
      timestamp: Date.now(),
    });
  }

  private evict(id: string): void {
    const state = this.runtimeStates.get(id);
    if (!state) return;

    state.residency = "cold";
    state.loadedSections = [];
    state.tokenCost = 0;

    this.emit({
      type: "skill_evicted",
      skill_id: id,
      residency: "cold",
      timestamp: Date.now(),
    });
  }

  // ---- Progressive Hydration ----

  private hydrateSkill(id: string): void {
    const state = this.runtimeStates.get(id);
    if (!state) return;

    // Load planner when present; otherwise leave sections empty so the prompt
    // builder falls back to the full skill body.
    if (state.entry.sectionRanges?.planner && !state.loadedSections.includes("planner")) {
      state.loadedSections.push("planner");
      this.emit({
        type: "skill_hydrated",
        skill_id: id,
        sections: ["planner"],
        timestamp: Date.now(),
      });
    }

    // Recompute token cost
    state.tokenCost = this.computeTokenCost(state);
  }

  /** Load execution section (called when tool execution starts) */
  hydrateExecution(id: string): void {
    const state = this.runtimeStates.get(id);
    if (!state || state.residency !== "hot") return;

    if (!state.loadedSections.includes("execution")) {
      state.loadedSections.push("execution");
      state.tokenCost = this.computeTokenCost(state);
      this.emit({
        type: "skill_hydrated",
        skill_id: id,
        sections: ["execution"],
        timestamp: Date.now(),
      });
    }
  }

  /** HOT skill IDs for the current turn. */
  getHotSkillIds(): string[] {
    return [...this.runtimeStates.entries()]
      .filter(([, state]) => state.residency === "hot")
      .map(([id]) => id);
  }

  /** Load execution sections for all HOT skills (called when tool execution starts). */
  hydrateExecutionForHotSkills(): void {
    for (const id of this.getHotSkillIds()) {
      this.hydrateExecution(id);
      this.markSkillActive(id);
    }
  }

  /** Load recovery sections for all HOT skills (called on tool failure). */
  hydrateRecoveryForHotSkills(): void {
    for (const id of this.getHotSkillIds()) {
      this.hydrateRecovery(id);
      this.markSkillActive(id);
    }
  }

  /** Load recovery section (called on failure) */
  hydrateRecovery(id: string): void {
    const state = this.runtimeStates.get(id);
    if (!state || state.residency !== "hot") return;

    if (!state.loadedSections.includes("recovery")) {
      state.loadedSections.push("recovery");
      state.tokenCost = this.computeTokenCost(state);
      this.emit({
        type: "skill_hydrated",
        skill_id: id,
        sections: ["recovery"],
        timestamp: Date.now(),
      });
    }
  }

  // ---- Budget ----

  private computeTokenCost(state: SkillRuntimeState): number {
    let total = 0;
    for (const section of state.loadedSections) {
      const content = this.getSectionContent(state, section);
      total += Math.ceil(content.length / 4);
    }
    if (state.loadedSections.length === 0 && state.body) {
      total = Math.ceil(state.body.length / 4);
    }
    return Math.min(total, state.entry.maxTokens);
  }

  private getSkillsTokenBudget(): number {
    return Math.floor(this.budgetBase * this.config.max_token_budget_ratio);
  }

  private enforceBudget(): void {
    const budget = this.getSkillsTokenBudget();
    const hotStates = [...this.runtimeStates.values()]
      .filter((s) => s.residency === "hot")
      .sort((a, b) => a.lastActiveTurn - b.lastActiveTurn);

    let totalCost = hotStates.reduce((sum, s) => sum + s.tokenCost, 0);

    while (totalCost > budget && hotStates.length > 0) {
      const victim = hotStates.shift()!;
      this.emit({
        type: "skill_budget_exceeded",
        skill_id: victim.entry.id,
        token_cost: victim.tokenCost,
        timestamp: Date.now(),
      });
      this.demote(victim.entry.id, "warm");
      totalCost -= victim.tokenCost;
    }
  }

  /** Update the budget base (called each turn with compiler.token_budget). */
  setBudgetBase(totalTokenBudget: number): void {
    this.budgetBase = totalTokenBudget;
    this.enforceBudget();
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

  getRuntimeStates(): Map<string, SkillRuntimeState> {
    return new Map(this.runtimeStates);
  }

  getSkillCount(): number {
    return this.index.length;
  }

  getResidencyCounts(): { hot: number; warm: number; cold: number } {
    let hot = 0;
    let warm = 0;
    let cold = 0;
    for (const state of this.runtimeStates.values()) {
      if (state.residency === "hot") hot++;
      else if (state.residency === "warm") warm++;
      else cold++;
    }
    return { hot, warm, cold };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }
}
