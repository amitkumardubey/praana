import { describe, expect, it } from "vitest";
import { parseCliArgs, resolveUiMode, resolveScreenMode } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("parses help flag", () => {
    const parsed = parseCliArgs(["--help"]);
    expect(parsed.showHelp).toBe(true);
  });

  it("parses debug and config flags", () => {
    const parsed = parseCliArgs(["--debug", "--config", "/tmp/praana.toml"]);
    expect(parsed.debug).toBe(true);
    expect(parsed.configPath).toBe("/tmp/praana.toml");
  });

  it("parses short config flag", () => {
    const parsed = parseCliArgs(["-c", "praana.config.toml"]);
    expect(parsed.configPath).toBe("praana.config.toml");
  });

  it("parses incognito flag", () => {
    expect(parseCliArgs(["--incognito"]).incognito).toBe(true);
    expect(parseCliArgs(["-I"]).incognito).toBe(true);
  });

  it("parses resume mode and session id", () => {
    const parsed = parseCliArgs(["resume", "01ABC"]);
    expect(parsed.resumeMode).toBe(true);
    expect(parsed.sessionId).toBe("01ABC");
  });

  it("parses ui and screen flags", () => {
    const parsed = parseCliArgs(["--ui", "tui", "--screen", "alternate"]);
    expect(parsed.uiMode).toBe("tui");
    expect(parsed.screenMode).toBe("alternate");
  });

  it("falls back to readline when tui is not interactive", () => {
    expect(resolveUiMode("tui", undefined, false)).toBe("readline");
    expect(resolveUiMode("tui", undefined, true)).toBe("tui");
  });

  it("resolves screen mode with CLI override", () => {
    expect(resolveScreenMode("preserve", "alternate")).toBe("alternate");
    expect(resolveScreenMode("preserve", undefined)).toBe("preserve");
  });
});
