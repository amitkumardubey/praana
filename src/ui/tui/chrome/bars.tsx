/**
 * Solid identity + glance chrome bars.
 */
import type { Accessor } from "solid-js";

export function IdentityBar(props: { line: Accessor<string> }) {
  return (
    <box id="identity-bar" flexDirection="row" flexShrink={0}>
      <text>{props.line()}</text>
    </box>
  );
}

export function GlanceBar(props: { line: Accessor<string> }) {
  return (
    <box id="glance-bar" flexDirection="row" flexShrink={0}>
      <text>{props.line()}</text>
    </box>
  );
}
