import React from "react";
import { Box, Text } from "ink";
import type { StatusBarInput } from "../../status-bar.js";
import { PALETTE } from "./palette.js";

export function StatusBarView({ status }: { status: StatusBarInput }) {
  const { memoryStats, currentTask, skills } = status;

  const pct = status.contextWindowTokens > 0
    ? Math.min(100, Math.round((status.contextUsedTokens / status.contextWindowTokens) * 100))
    : 0;
  const modelShort = status.model.split("/").pop() ?? status.model;
  const memStr = status.incognito ? "incognito" : status.memoryEnabled ? "on" : "off";
  const skillsCount = skills.length;

  let stateStr = "";
  if (memoryStats && (memoryStats.active > 0 || memoryStats.soft > 0 || memoryStats.hard > 0)) {
    const parts: string[] = [];
    if (memoryStats.active > 0) parts.push(`${memoryStats.active}A`);
    if (memoryStats.soft > 0) parts.push(`${memoryStats.soft}S`);
    if (memoryStats.hard > 0) parts.push(`${memoryStats.hard}H`);
    stateStr = parts.join("/");
  }

  return (
    <Box>
      <Text color={PALETTE.assistant}>{`📦 model: ${status.model}`}</Text>
      <Text dimColor>  |  </Text>
      <Text color={pct > 90 ? PALETTE.error : pct > 70 ? PALETTE.tool : PALETTE.muted}>
        {`🧠 ctx: ${pct}%`}
      </Text>
      <Text dimColor>  |  </Text>
      <Text color={memStr === "on" ? PALETTE.user : PALETTE.muted}>
        {`💾 mem: ${memStr}`}
      </Text>
      {skillsCount > 0 && (
        <>
          <Text dimColor>  |  </Text>
          <Text color={PALETTE.tool}>
            {`🛠️  ${skillsCount}sk${stateStr ? ` [${stateStr}]` : ""}`}
          </Text>
        </>
      )}
      {currentTask && (
        <>
          <Text dimColor>  |  </Text>
          <Text color={PALETTE.muted}>{`🎯 ${currentTask}`}</Text>
        </>
      )}
    </Box>
  );
}
