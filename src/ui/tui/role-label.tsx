import React from "react";
import { Text } from "ink";
import type { TranscriptEntry } from "./reducer.js";
import { PALETTE } from "./palette.js";

export function RoleLabel({ role }: { role: TranscriptEntry["role"] }) {
  switch (role) {
    case "user":
      return <Text color={PALETTE.user} bold>You</Text>;
    case "assistant":
      return <Text color={PALETTE.assistant} bold>ARIA</Text>;
    case "thinking":
      return <Text color={PALETTE.thinking} bold>think</Text>;
    case "tool":
      return <Text color={PALETTE.tool} bold>tool</Text>;
    case "tool_result":
      return <Text color={PALETTE.muted} bold>result</Text>;
    default:
      return <Text color={PALETTE.system} bold>system</Text>;
  }
}
