/**
 * Centered overlay frame — same chrome as /model and the slash palette.
 */
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";

const OVERLAY_Z = 1000;

/** Palette popup fill — matches /model and the slash command palette. */
export const OVERLAY_BACKGROUND = "#2a2d37";
export const OVERLAY_BORDER = "#3d414d";

/** Rows the frame spends on its border and padding, outside the children. */
export const OVERLAY_FRAME_CHROME_ROWS = 4;

/** Columns the frame spends on its border and padding, outside the children. */
export const OVERLAY_FRAME_CHROME_COLS = 4;

/** Frame height cap for a terminal height. Callers that budget child rows need this. */
export function overlayFrameMaxHeight(termHeight: number, explicitMax?: number): number {
  return explicitMax ?? Math.max(8, (termHeight || 24) - 6);
}

/** Frame width for a terminal width; callers that budget columns need this. */
export function overlayFrameWidth(termWidth: number, explicitWidth?: number): number {
  return Math.min(explicitWidth ?? 70, Math.max(20, (termWidth || 80) - 4));
}

/** Usable text columns inside the frame, for truncating a child line. */
export function overlayFrameInnerWidth(termWidth: number, explicitWidth?: number): number {
  return Math.max(1, overlayFrameWidth(termWidth, explicitWidth) - OVERLAY_FRAME_CHROME_COLS);
}

export function OverlayFrame(props: {
  children: JSX.Element;
  width?: number;
  maxHeight?: number;
  backgroundColor?: string;
  borderColor?: string;
}) {
  const dimensions = useTerminalDimensions();
  const boxWidth = () => overlayFrameWidth(dimensions().width, props.width);
  const boxMaxHeight = () => overlayFrameMaxHeight(dimensions().height, props.maxHeight);
  const left = () =>
    Math.max(0, Math.floor(((dimensions().width || 80) - boxWidth()) / 2));
  // A fifth of the terminal is a comfortable inset, but a frame that is almost
  // as tall as the terminal would then overhang the bottom and have its last
  // rows cut off. Clamp so the whole frame stays on screen.
  const top = () => {
    const preferred = Math.max(1, Math.floor((dimensions().height || 24) / 5));
    return Math.max(0, Math.min(preferred, (dimensions().height || 24) - boxMaxHeight()));
  };

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
