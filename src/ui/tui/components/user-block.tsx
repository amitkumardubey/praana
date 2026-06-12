import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

export function UserBlock({
  text,
  marginTop,
  showTurnBreak,
}: {
  text: string;
  marginTop: boolean;
  showTurnBreak?: boolean;
}) {
  return (
    <Box
      flexDirection="column"
      marginTop={showTurnBreak || marginTop ? 1 : 0}
      borderStyle="single"
      borderColor={PALETTE.user}
      borderLeft
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingX={1}
      paddingY={1}
    >
      <Text wrap="wrap" color={PALETTE.user}>{text || " "}</Text>
    </Box>
  );
}
