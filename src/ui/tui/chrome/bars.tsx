/**
 * Solid identity + glance chrome bars.
 */
import { For } from "solid-js";
import type { Accessor } from "solid-js";
import type { TextSegment } from "../theme.js";

export function IdentityBar(props: { segments: Accessor<TextSegment[]> }) {
  return (
    <box id="identity-bar" flexDirection="row" flexShrink={0}>
      <text>
        <For each={props.segments()}>
          {(seg) => seg.style ? <span style={seg.style}>{seg.text}</span> : seg.text}
        </For>
      </text>
    </box>
  );
}

export function GlanceBar(props: { segments: Accessor<TextSegment[]> }) {
  return (
    <box id="glance-bar" flexDirection="row" flexShrink={0}>
      <text>
        <For each={props.segments()}>
          {(seg) => seg.style ? <span style={seg.style}>{seg.text}</span> : seg.text}
        </For>
      </text>
    </box>
  );
}
