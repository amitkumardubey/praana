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

  it("parses bare resume without session id", () => {
    const parsed = parseCliArgs(["resume"]);
    expect(parsed.resumeMode).toBe(true);
    expect(parsed.sessionId).toBeNull();
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

  it("parses version flag", () => {
    expect(parseCliArgs(["--version"]).versionMode).toBe(true);
    expect(parseCliArgs(["-v"]).versionMode).toBe(true);
  });

  it("parses doctor subcommand", () => {
    expect(parseCliArgs(["doctor"]).doctorMode).toBe(true);
  });

  it("parses upgrade and update aliases", () => {
    expect(parseCliArgs(["upgrade"]).upgradeMode).toBe(true);
    expect(parseCliArgs(["update"]).upgradeMode).toBe(true);
    expect(parseCliArgs(["upgrade", "--force"]).force).toBe(true);
  });

  it("parses home-dir flag", () => {
    expect(parseCliArgs(["--home-dir", "/tmp/praana"]).homeDir).toBe("/tmp/praana");
    expect(parseCliArgs(["-H", "/tmp/praana"]).homeDir).toBe("/tmp/praana");
  });

  it("parses providers subcommand", () => {
    expect(parseCliArgs(["providers"]).providersMode).toBe(true);
  });

  it("does not treat --providers or -p as providers mode", () => {
    expect(parseCliArgs(["--providers"]).providersMode).toBe(false);
    expect(parseCliArgs(["-p"]).providersMode).toBe(false);
  });

  it("parses models subcommand without provider", () => {
    const parsed = parseCliArgs(["models"]);
    expect(parsed.modelsMode).toBe(true);
    expect(parsed.modelsProvider).toBeNull();
  });

  it("parses models subcommand with provider filter", () => {
    const parsed = parseCliArgs(["models", "openrouter"]);
    expect(parsed.modelsMode).toBe(true);
    expect(parsed.modelsProvider).toBe("openrouter");
  });

  it("parses run subcommand with positional prompt", () => {
    const parsed = parseCliArgs(["run", "fix the failing tests"]);
    expect(parsed.runMode).toBe(true);
    expect(parsed.runPrompt).toBe("fix the failing tests");
    expect(parsed.runMaxSteps).toBeNull();
  });

  it("parses run --prompt and --max-steps", () => {
    const parsed = parseCliArgs([
      "run",
      "--prompt",
      "install deps and run tests",
      "--max-steps",
      "40",
    ]);
    expect(parsed.runMode).toBe(true);
    expect(parsed.runPrompt).toBe("install deps and run tests");
    expect(parsed.runMaxSteps).toBe(40);
  });

  it("parses run with flags before prompt", () => {
    const parsed = parseCliArgs(["run", "--max-steps", "10", "do the thing"]);
    expect(parsed.runMode).toBe(true);
    expect(parsed.runPrompt).toBe("do the thing");
    expect(parsed.runMaxSteps).toBe(10);
  });

  it("run without prompt still sets runMode", () => {
    const parsed = parseCliArgs(["run"]);
    expect(parsed.runMode).toBe(true);
    expect(parsed.runPrompt).toBeNull();
  });
});
