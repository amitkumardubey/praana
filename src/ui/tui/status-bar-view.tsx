import React from "react";
import { Box, Text } from "ink";
import type { StatusBarInput } from "../../status-bar.js";
import { formatModelStatusLabel, formatTokenCount, formatRepoLabel } from "../../status-bar.js";
import { PALETTE } from "./palette.js";
import { getTerminalWidth } from "./terminal-width.js";

function formatStateLabel(stats: { active: number; soft: number; hard: number }): string {
  const parts: string[] = [];
  if (stats.active > 0) parts.push(`${stats.active} active`);
  if (stats.soft > 0) parts.push(`${stats.soft} soft`);
  if (stats.hard > 0) parts.push(`${stats.hard} hard`);
  return parts.join(" · ");
}

function formatMemLabel(status: StatusBarInput): string {
  if (status.incognito) return "incognito";
  if (!status.memoryEnabled) return "off (config)";
  return "on";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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
  const memStr = formatMemLabel(status);
  const skillsCount = skills.length;
  const stateStr = formatStateLabel(memoryStats);
  const ctxStr =
    status.contextWindowTokens > 0
      ? `${formatTokenCount(status.contextUsedTokens)}/${formatTokenCount(status.contextWindowTokens)} (${pct}%)`
      : `${pct}%`;
  const thinkStr = status.thinking ? "on" : "off";
  const taskLabel = currentTask ? truncate(currentTask, Math.max(24, width - 20)) : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={PALETTE.success}>{`📁 ${repoStr}`}</Text>
        <Text dimColor>  |  </Text>
        <Text color={PALETTE.assistant}>{`📦 ${modelLabel}`}</Text>
        <Text dimColor>  |  </Text>
        <Text color={pct > 90 ? PALETTE.error : pct > 70 ? PALETTE.warning : PALETTE.muted}>
          {`🧠 ctx ${ctxStr}`}
        </Text>
        <Text dimColor>  |  </Text>
        <Text color={status.thinking ? PALETTE.thinking : PALETTE.muted}>
          {`💭 think ${thinkStr}`}
        </Text>
        <Text dimColor>  |  </Text>
        <Text color={memStr === "on" ? PALETTE.user : PALETTE.muted}>
          {`💾 mem ${memStr}`}
        </Text>
        {skillsCount > 0 && (
          <>
            <Text dimColor>  |  </Text>
            <Text color={PALETTE.tool}>{`🛠️  ${skillsCount} skills`}</Text>
          </>
        )}
        {stateStr && (
          <>
            <Text dimColor>  |  </Text>
            <Text color={PALETTE.muted}>{`◇ ${stateStr}`}</Text>
          </>
        )}
        {status.debug && (
          <>
            <Text dimColor>  |  </Text>
            <Text color={PALETTE.warning}>{`🐞 debug`}</Text>
          </>
        )}
      </Box>
      {taskLabel ? (
        <Box marginTop={0}>
          <Text color={PALETTE.muted} dimColor>{`🎯 ${taskLabel}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
