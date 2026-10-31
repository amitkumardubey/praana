import { describe, it, expect } from "bun:test";
import {
  wrapUrlForDisplay,
  resolveOAuthSelectSelection,
  OAuthUserCancelledError,
} from "../src/ui/tui/oauth-login-ui.js";

describe("wrapUrlForDisplay", () => {
  it("keeps short urls on one line", () => {
    expect(wrapUrlForDisplay("https://example.com/a", 72)).toEqual([
      "https://example.com/a",
    ]);
  });

  it("wraps long urls", () => {
    const url = "https://example.com/" + "a".repeat(100);
    const lines = wrapUrlForDisplay(url, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(url);
  });
});

describe("OAuth select cancel", () => {
  it("undismissed select is a user cancel, not a failed login", () => {
    expect(resolveOAuthSelectSelection("device-flow")).toBe("device-flow");
    expect(() => resolveOAuthSelectSelection(undefined)).toThrow(
      OAuthUserCancelledError,
    );
    expect(() => resolveOAuthSelectSelection(undefined)).toThrow(/cancelled/);
  });
});
