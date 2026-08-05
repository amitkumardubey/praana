/**
 * Solid identity + glance chrome bars (launch-screen lock).
 */
import { For } from "solid-js";
import type { Accessor } from "solid-js";
import type { TextSegment } from "../theme.js";

function SegmentRow(props: { segments: Accessor<TextSegment[]> }) {
  return (
    <text>
      <For each={props.segments()}>
        {(seg) => (seg.style ? <span style={seg.style}>{seg.text}</span> : seg.text)}
      </For>
    </text>
  );
}

export function IdentityBar(props: { segments: Accessor<TextSegment[]> }) {
  return (
    <box id="identity-bar" flexDirection="row" flexShrink={0} width="100%">
      <SegmentRow segments={props.segments} />
    </box>
  );
}

/** Split glance: metrics left, green on-flags right. */
export function GlanceBar(props: {
  metrics: Accessor<TextSegment[]>;
  flags: Accessor<TextSegment[]>;
}) {
  return (
    <box id="glance-bar" flexDirection="row" flexShrink={0} width="100%">
      <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row">
        <SegmentRow segments={props.metrics} />
      </box>
      <box flexShrink={0} flexDirection="row" marginLeft={2}>
        <SegmentRow segments={props.flags} />
      </box>
    </box>
  );
}
