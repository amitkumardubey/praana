/**
 * Shared overlay helper for OpenTUI.
 *
 * Floats a BoxRenderable above everything else using position:absolute + zIndex,
 * centering it on the root when no anchor is provided.
 */
import { BoxRenderable, type RenderContext, type Renderable } from "@opentui/core";

export interface OverlayHandle {
  node: BoxRenderable;
}

const OVERLAY_Z_INDEX = 1000;

export interface OverlayAnchorOptions {
  top?: number;
  left?: number;
}

interface RootProvider {
  root: Renderable;
  requestRender(): void;
}

export function showOverlay(
  renderer: RootProvider,
  node: BoxRenderable,
  anchor?: OverlayAnchorOptions,
): OverlayHandle {
  node.position = "absolute";
  node.zIndex = OVERLAY_Z_INDEX;
  if (anchor?.top !== undefined) node.top = anchor.top;
  if (anchor?.left !== undefined) node.left = anchor.left;
  if (anchor?.top === undefined && anchor?.left === undefined) {
    const rootWidth = renderer.root.width ?? 80;
    const rootHeight = renderer.root.height ?? 24;
    node.top = Math.max(0, Math.floor((rootHeight - (node.height ?? 0)) / 2));
    node.left = Math.max(0, Math.floor((rootWidth - (node.width ?? 0)) / 2));
  }
  renderer.root.add(node);
  renderer.requestRender();
  return { node };
}

export function hideOverlay(renderer: RootProvider, handle: OverlayHandle): void {
  renderer.root.remove(handle.node);
  renderer.requestRender();
}