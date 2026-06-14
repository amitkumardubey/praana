import React from "react";
import { Box, Text } from "ink";
import type { StatusBarInput } from "../../status-bar.js";
import { formatModelStatusLabel, formatTokenCount, formatRepoLabel } from "../../status-bar.js";
import { PALETTE } from "./palette.js";
import { getTerminalWidth } from "./terminal-width.js";

/** Compact state tiers, e.g. "2A·1S" — only non-zero tiers, "" when empty. */
function formatStateLabel(stats: { active: number; soft: number; hard: number }): string {
  const parts: string[] = [];
  if (stats.active > 0) parts.push(`${stats.active}A`);
  if (stats.soft > 0) parts.push(`${stats.soft}S`);
  if (stats.hard > 0) parts.push(`${stats.hard}H`);
  return parts.join("·");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

interface Segment {
  text: string;
  color: string;
  dim?: boolean;
}

export function StatusBarView({
  status,
}: {
  status: StatusBarInput;
}) {
  const { memoryStats, currentTask, skills } = status;
  const width = getTerminalWidth();
  const repoLabel = formatRepoLabel(status.repoPath, status.cwd);
  const repoStr = status.branch ? `${repoLabel} · ${status.branch}` : repoLabel;

  const pct = status.contextWindowTokens > 0
    ? Math.min(100, Math.round((status.contextUsedTokens / status.contextWindowTokens) * 100))
    : 0;
  const { provider, modelShort } = formatModelStatusLabel(status.model);
  const modelLabel = provider ? `${provider} · ${modelShort}` : modelShort;
  const ctxStr =
    status.contextWindowTokens > 0
      ? `${formatTokenCount(status.contextUsedTokens)}/${formatTokenCount(status.contextWindowTokens)} ${pct}%`
      : `${pct}%`;
  const stateStr = formatStateLabel(memoryStats);
  const taskLabel = currentTask ? truncate(currentTask, Math.max(24, width - 4)) : null;

  /* Line 1 — identity / config: where you are and what you're running. */
  const identity: Segment[] = [
    { text: `📁 ${repoStr}`, color: PALETTE.success },
    { text: `📦 ${modelLabel}`, color: PALETTE.assistant },
  ];

  /* Line 2 — live session state. Flags appear only when they deviate
     from the quiet default, so this line stays short. */
  const live: Segment[] = [
    {
      text: `🧠 ${ctxStr}`,
      color: pct > 90 ? PALETTE.error : pct > 70 ? PALETTE.warning : PALETTE.muted,
    },
  ];
  if (status.thinking) live.push({ text: "💭 think", color: PALETTE.thinking });
  if (status.incognito) {
    live.push({ text: "🕶 incognito", color: PALETTE.warning });
  } else if (!status.memoryEnabled) {
    live.push({ text: "💾 mem off", color: PALETTE.muted, dim: true });
  }
  if (skills.length > 0) live.push({ text: `🛠️  ${skills.length}`, color: PALETTE.tool });
  if (stateStr) live.push({ text: `◇ ${stateStr}`, color: PALETTE.muted, dim: true });
  if (status.debug) live.push({ text: "🐞 debug", color: PALETTE.warning });

  return (
    <Box flexDirection="column">
      <SegmentRow segments={identity} />
      <SegmentRow segments={live} />
      {taskLabel ? (
        <Box>
          <Text color={PALETTE.muted} dimColor>{`🎯 ${taskLabel}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SegmentRow({ segments }: { segments: Segment[] }) {
  if (segments.length === 0) return null;
  return (
    <Box>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Text dimColor>{" · "}</Text> : null}
          <Text color={seg.color} dimColor={seg.dim}>{seg.text}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
