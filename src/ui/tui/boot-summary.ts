/** Boot welcome panel for the pi-tui TUI (design §5.1). */
import { homedir } from "node:os";
import { basename } from "node:path";
import type { Session } from "../../session.js";
import { formatModelStatusLabel } from "../../status-bar.js";

export interface TuiBootSummaryInput {
  session: Session;
  model: string;
  cwd: string;
  isResume: boolean;
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

function formatStateTiers(session: Session): string {
  const mem = session.getMemoryStats();
  const tiers: string[] = [];
  if (mem.active > 0) tiers.push(`${mem.active}A`);
  if (mem.soft > 0) tiers.push(`${mem.soft}S`);
  if (mem.hard > 0) tiers.push(`${mem.hard}H`);
  return tiers.join("·");
}

/** Multi-line boot summary block (indented, label-aligned). */
export function formatTuiBootSummary(input: TuiBootSummaryInput): string[] {
  const { session, model, cwd, isResume } = input;
  const lines: string[] = [];

  if (isResume) {
    const turns = session.getTurnCount();
    const tiers = formatStateTiers(session);
    const restored = tiers ? ` · ${tiers} restored` : "";
    lines.push(`resumed · ${turns} turn${turns === 1 ? "" : "s"}${restored}`);
    return lines;
  }

  const { provider, modelShort } = formatModelStatusLabel(model);
  const modelLabel = provider ? `${provider} · ${modelShort}` : modelShort;
  lines.push(`model    ${modelLabel}`);

  const branch = session.getGitBranch();
  const repoRoot = session.getRepoRoot();
  const repoName = basename(repoRoot);
  const cwdLabel = shortenPath(cwd);
  const cwdLine =
    repoName && cwdLabel !== repoName && cwd !== repoRoot
      ? `${cwdLabel} (${repoName})`
      : cwdLabel;
  lines.push(`cwd      ${branch ? `${cwdLine} · ${branch}` : cwdLine}`);

  const digestEntries = session.digest
    ? session.digest.split("\n").filter((l) => l.trim().length > 0).length
    : 0;
  const memParts: string[] = [];
  if (digestEntries > 0) memParts.push(`${digestEntries} recalled`);
  const dbCount = session.getPersistentMemoryEntryCount();
  if (dbCount !== null && dbCount > 0) memParts.push(`${dbCount} in db`);
  if (session.isIncognito()) {
    memParts.push("incognito");
  } else if (!session.memoryEnabled) {
    memParts.push("off");
  }
  if (session.isContextEngineEnabled()) memParts.push("engine on");
  lines.push(`memory   ${memParts.length > 0 ? memParts.join(" · ") : "on"}`);

  const skillCount = session.skills.length;
  lines.push(
    `skills   ${skillCount > 0 ? `${skillCount} available` : "none found"}`,
  );

  lines.push("─".repeat(46));
  lines.push("/help for commands · /exit to save · ctrl-c to interrupt");

  return lines;
}
