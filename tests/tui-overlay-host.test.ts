/**
 * Unit tests for the TUI overlay host's key bindings
 * (`src/ui/tui/overlays/host.tsx`).
 *
 * Coverage: the login/logout overlays cancel on Ctrl+C (like Escape), matching
 * the documented "modal setup / consent / login / logout screens keep their
 * own Ctrl+C (cancel)"; model/consent stay Escape-only from the host
 * (setup/consent handle Ctrl+C inside their own components); the palette
 * cancels on Escape and Ctrl+C.
 */
import { describe, expect, it } from "bun:test";
import { overlayBindingsFor } from "../src/ui/tui/overlays/host.js";

function keysOf(kind: string): string[] {
  return overlayBindingsFor(kind, {
    dismiss: () => {},
    paletteCancel: () => {},
  }).map((b) => b.key);
}

describe("overlay host key bindings", () => {
  it("login and logout overlays cancel on both Escape and Ctrl+C", () => {
    for (const kind of ["login", "logout"]) {
      const keys = keysOf(kind);
      expect(keys).toContain("escape");
      expect(keys).toContain("ctrl+c");
    }
  });

  it("model and consent overlays keep Escape-only bindings from the host", () => {
    for (const kind of ["model", "consent"]) {
      expect(keysOf(kind)).toEqual(["escape"]);
    }
  });

  it("palette cancels on Escape and Ctrl+C", () => {
    expect(keysOf("palette")).toEqual(["escape", "ctrl+c"]);
  });

  it("the main UI and slash overlay have no host-owned bindings", () => {
    expect(keysOf("none")).toEqual([]);
    expect(keysOf("slash")).toEqual([]);
  });

  it("bound commands dispatch to the provided handlers", () => {
    let dismissed = 0;
    let cancelled = 0;
    const bindings = overlayBindingsFor("login", {
      dismiss: () => {
        dismissed += 1;
      },
      paletteCancel: () => {
        cancelled += 1;
      },
    });
    bindings.find((b) => b.key === "ctrl+c")?.cmd();
    expect(dismissed).toBe(1);
    expect(cancelled).toBe(0);
  });
});
