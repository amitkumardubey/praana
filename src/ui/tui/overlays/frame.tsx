/**
 * Centered overlay frame — same chrome as /model and the slash palette.
 */
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";

const OVERLAY_Z = 1000;

/** Palette popup fill — matches /model and the slash command palette. */
export const OVERLAY_BACKGROUND = "#2a2d37";
export const OVERLAY_BORDER = "#3d414d";

export function OverlayFrame(props: {
  children: JSX.Element;
  width?: number;
  maxHeight?: number;
  backgroundColor?: string;
  borderColor?: string;
}) {
  const dimensions = useTerminalDimensions();
  const boxWidth = () =>
    Math.min(props.width ?? 70, Math.max(20, (dimensions().width || 80) - 4));
  const boxMaxHeight = () =>
    props.maxHeight ?? Math.max(8, (dimensions().height || 24) - 6);
  const left = () =>
    Math.max(0, Math.floor(((dimensions().width || 80) - boxWidth()) / 2));
  const top = () => Math.max(1, Math.floor((dimensions().height || 24) / 5));

  return (
    <box
      id="overlay-frame"
      position="absolute"
      zIndex={OVERLAY_Z}
      left={left()}
      top={top()}
      width={boxWidth()}
      maxHeight={boxMaxHeight()}
      border
      borderStyle="rounded"
      borderColor={props.borderColor ?? OVERLAY_BORDER}
      backgroundColor={props.backgroundColor ?? OVERLAY_BACKGROUND}
      padding={1}
      flexDirection="column"
    >
      {props.children}
    </box>
  );
}
