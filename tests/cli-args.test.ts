import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("parses help flag", () => {
    const parsed = parseCliArgs(["--help"]);
    expect(parsed.showHelp).toBe(true);
  });

  it("parses debug and config flags", () => {
    const parsed = parseCliArgs(["--debug", "--config", "/tmp/aria.toml"]);
    expect(parsed.debug).toBe(true);
    expect(parsed.configPath).toBe("/tmp/aria.toml");
  });

  it("parses short config flag", () => {
    const parsed = parseCliArgs(["-c", "aria.config.toml"]);
    expect(parsed.configPath).toBe("aria.config.toml");
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
});
