import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

export type ToastTone = "info" | "success" | "error";

function toastColor(tone: ToastTone): string {
  switch (tone) {
    case "error":
      return PALETTE.error;
    case "success":
      return PALETTE.success;
    default:
      return PALETTE.info;
  }
}

export function ToastLine({
  message,
  tone = "info",
}: {
  message: string;
  tone?: ToastTone;
}) {
  if (!message) return null;
  return (
    <Box paddingLeft={1}>
      <Text color={toastColor(tone)}>{message}</Text>
    </Box>
  );
}
