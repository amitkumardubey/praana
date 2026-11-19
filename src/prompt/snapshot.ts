import type { NativeAddonStatus } from "../native/index.js";
import { estimateTokens as estTokens } from "../token-estimate.js";

export interface SnapshotSkill {
  name: string;
  description: string;
}

export interface SnapshotInput {
  /** Local calendar date, already formatted by the caller. The clock is never read here. */
  date: string;
  /** Optional IANA zone name shown next to the date. */
  timeZone?: string;
  cwd: string;
  sessionId: string;
  nativeStatus?: NativeAddonStatus | null;
  /** Skill catalog entries, rendered in the given order. */
  skills?: readonly SnapshotSkill[];
  /** Token budget for the skills section. Zero or less emits nothing for it. */
  skillsTokenBudget: number;
  /** Memory index text (the digest). */
  memoryIndex?: string | null;
  memoryRecallEnabled?: boolean;
  /** Token budget for the memory section. Zero or less emits nothing for it. */
  memoryTokenBudget: number;
  /** Pre-rendered workflow section. */
  workflowSection?: string | null;
}

/**
 * Text of the first user-role message in the native layer order: the volatile,
 * per-session facts that must stay out of the stable system frame. Every input
 * is explicit and equal inputs give equal output. Sections with no content are
 * omitted. The skills and memory sections never exceed a positive budget; the
 * truncation marker counts inside it.
 */
export function buildSnapshot(input: SnapshotInput): string {
  const header = [
    "# Session Snapshot",
    "",
    `Current date: ${input.date}${input.timeZone ? ` (${input.timeZone})` : ""}`,
    `Working directory: ${input.cwd}`,
    `Session ID: ${input.sessionId}`,
  ].join("\n");
  const sections = [header];

  const native = buildNativeStatusSection(input.nativeStatus);
  if (native) sections.push(native);

  const skills = renderSkillEntries(input.skills ?? []);
  if (skills) {
    const { text } = trimToStrictTokenBudget(skills, input.skillsTokenBudget, "skills section truncated to token budget");
    if (text) sections.push(text);
  }

  if (input.memoryIndex?.trim()) {
    const memory = buildCrossSessionMemory(input.memoryIndex, input.memoryRecallEnabled ?? false);
    const { text } = trimToStrictTokenBudget(memory, input.memoryTokenBudget, "memory section truncated to token budget");
    if (text) sections.push(text);
  }

  if (input.workflowSection?.trim()) sections.push(input.workflowSection.trim());

  return sections.join("\n\n");
}

/** Section describing an unavailable or disabled native addon; null when it is available. */
export function buildNativeStatusSection(nativeStatus: NativeAddonStatus | null | undefined): string | null {
  if (!nativeStatus || nativeStatus.kind === "available") return null;
  const detail =
    nativeStatus.kind === "disabled"
      ? "disabled via config"
      : `unavailable: ${nativeStatus.reason}`;
  return [
    "## Native Addon",
    "",
    `Tree-sitter code-intel addon ${detail} — code_parse/code_symbols/code_imports/code_definition/code_references will soft-fail. Prefer search_code or find_files for code exploration.`,
  ].join("\n");
}

export function buildCrossSessionMemory(digest: string, recallEnabled = false): string {
  // The trust caveat lives in the store's INDEX_PREFACE, which already opens the
  // digest text; repeating it here would double the caveat in a compiled prompt.
  const lines = ["# Cross-Session Memory", "", digest, ""];
  if (recallEnabled) {
    lines.push('Use recall({ query: "..." }) to search file memories, or recall({ name: "..." }) to read one in full.');
  }
  return lines.join("\n");
}

function renderSkillEntries(skills: readonly SnapshotSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "## Available Skills",
    "",
    "Load a skill with load_skill(skill_id) when it is relevant:",
    "",
    ...skills.map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n");
}

/**
 * Strict counterpart of `trimSectionToTokenBudget`: the result, marker included,
 * never exceeds a positive budget, and a budget of zero or less yields no text.
 * Whole lines are kept while they fit; an oversized first line is cut by code
 * point. If even the marker does not fit, nothing is emitted.
 */
export function trimToStrictTokenBudget(
  text: string,
  maxTokens: number,
  truncationNote: string,
): { text: string; truncated: boolean } {
  if (!text) return { text: "", truncated: false };
  // Written so that NaN also emits nothing.
  if (!(maxTokens > 0)) return { text: "", truncated: true };
  if (estTokens(text) <= maxTokens) return { text, truncated: false };

  const marker = `... (${truncationNote})`;
  if (estTokens(marker) > maxTokens) return { text: "", truncated: true };

  const lines = text.split("\n");
  const withMarker = (kept: string) => `${kept}\n${marker}`;

  // The estimate never decreases as lines or characters are added, so bisect.
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estTokens(withMarker(lines.slice(0, mid).join("\n"))) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) return { text: withMarker(lines.slice(0, lo).join("\n")), truncated: true };

  const chars = Array.from(lines[0]!);
  let cLo = 0;
  let cHi = chars.length;
  while (cLo < cHi) {
    const mid = Math.ceil((cLo + cHi) / 2);
    if (estTokens(withMarker(chars.slice(0, mid).join(""))) <= maxTokens) cLo = mid;
    else cHi = mid - 1;
  }
  return { text: cLo > 0 ? withMarker(chars.slice(0, cLo).join("")) : marker, truncated: true };
}
