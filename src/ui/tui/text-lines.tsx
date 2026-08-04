/**
 * Small helper for rendering a fixed block of lines with per-line styling,
 * using native <span>/<br> text modifiers instead of joining pre-styled
 * strings into one blob.
 */
import { For, Show } from "solid-js";
import type { SpanStyle } from "./theme.js";

export type LineChunk = string | { text: string; style?: SpanStyle };
export type LineSpec = LineChunk | LineChunk[];

function chunks(line: LineSpec): LineChunk[] {
  return Array.isArray(line) ? line : [line];
}

export function Lines(props: { lines: LineSpec[] }) {
  return (
    <text>
      <For each={props.lines}>
        {(line, i) => (
          <>
            <Show when={i() > 0}>
              <br />
            </Show>
            <For each={chunks(line)}>
              {(chunk) =>
                typeof chunk === "string" ? chunk : <span style={chunk.style}>{chunk.text}</span>
              }
            </For>
          </>
        )}
      </For>
    </text>
  );
}
