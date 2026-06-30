/**
 * Top identity chrome — brand, model, cwd · branch (design §5).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatTuiIdentityLine } from "./glance-format.js";
import { paintZoneLine, type ZoneKind } from "../theme.js";

export class IdentityBar implements Component {
  private input: StatusBarInput | null = null;
  private backgroundZones = true;

  setInput(input: StatusBarInput): void {
    this.input = input;
  }

  setBackgroundZones(enabled: boolean): void {
    this.backgroundZones = enabled;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    const line = this.input
      ? formatTuiIdentityLine(this.input)
      : "praana";
    const painted = paintZoneLine(
      truncateToWidth(" " + line, width, "…"),
      "chrome" satisfies ZoneKind,
      this.backgroundZones,
      width,
    );
    return [painted];
  }
}
