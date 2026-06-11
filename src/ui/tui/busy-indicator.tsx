import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { PALETTE } from "./palette.js";

export function BusyIndicator() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % 4), 400);
    return () => clearInterval(t);
  }, []);
  const dots = [".  ", ".. ", "...", " .."][frame] ?? "...";
  return (
    <Box>
      <Text color={PALETTE.thinking} dimColor>{dots}</Text>
    </Box>
  );
}
