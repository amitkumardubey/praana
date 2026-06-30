import { describe, it, expect } from "bun:test";
import { parseCliArgs } from "../src/cli-args.js";

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

  it("ignores unknown flags gracefully", () => {
    const parsed = parseCliArgs(["--unknown-flag", "value"]);
    expect(parsed.showHelp).toBe(false);
    expect(parsed.debug).toBe(false);
  });

  it("parses force flag", () => {
    expect(parseCliArgs(["--force"]).force).toBe(true);
    expect(parseCliArgs(["-f"]).force).toBe(true);
  });
});
