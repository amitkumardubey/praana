import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  getConfigWarnings,
  getLoadedConfigSources,
  deepMerge,
  mergeArrays,
} from "../src/config.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import { APP_HOME_DIR } from "../src/app-identity.js";

describe("deepMerge array strategies", () => {
  it("appends and dedupes shell.allowed_paths (global + local)", () => {
    const global = { shell: { enabled: true, allowed_paths: ["/a", "/b"] } };
    const local = { shell: { allowed_paths: ["/c", "/a"] } };
    const merged = deepMerge(global, local);
    expect(merged.shell.allowed_paths).toEqual(["/a", "/b", "/c"]);
    expect(merged.shell.enabled).toBe(true);
  });

  it("keeps base when append override is empty", () => {
    const base = { shell: { enabled: true, allowed_paths: ["/a", "/b"] } };
    const override = { shell: { allowed_paths: [] as string[] } };
    const merged = deepMerge(base, override);
    expect(merged.shell.allowed_paths).toEqual(["/a", "/b"]);
  });

  it("does not alias base array when append override is empty", () => {
    const basePaths = ["/a", "/b"];
    const base = { shell: { enabled: true, allowed_paths: basePaths } };
    const merged = deepMerge(base, { shell: { allowed_paths: [] as string[] } });
    (merged.shell.allowed_paths as string[]).push("/mutated");
    expect(basePaths).toEqual(["/a", "/b"]);
  });

  it("replaces arrays that are not allowlists", () => {
    const base = {
      project_detection: {
        enabled: true,
        manual_languages: ["TypeScript"],
      },
    };
    const override = {
      project_detection: {
        manual_languages: ["Python"],
      },
    };
    const merged = deepMerge(base, override);
    expect(merged.project_detection.manual_languages).toEqual(["Python"]);
    expect(merged.project_detection.enabled).toBe(true);
  });

  it("prepends and dedupes when strategy is prepend", () => {
    expect(mergeArrays(["/a", "/b"], ["/c", "/a"], "prepend")).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
    expect(mergeArrays(["/a"], [], "prepend")).toEqual(["/a"]);
  });

  it("merges multi-source layers like loadConfig order", () => {
    const defaults = {
      shell: { enabled: false, allowed_paths: [] as string[] },
      project_detection: { enabled: true },
    };
    const globalUser = {
      shell: { enabled: true, allowed_paths: ["/home/global", "/shared"] },
    };
    const localUser = {
      shell: { allowed_paths: ["/project", "/shared"] },
      project_detection: { manual_frameworks: ["React"] },
    };
    const merged = deepMerge(deepMerge(defaults, globalUser), localUser);
    expect(merged.shell.enabled).toBe(true);
    expect(merged.shell.allowed_paths).toEqual([
      "/home/global",
      "/shared",
      "/project",
    ]);
    expect(merged.project_detection.manual_frameworks).toEqual(["React"]);
  });
});

describe("loadConfig multi-source array merge", () => {
  let praanaHome: string;
  let projectDir: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "praana-proj-"));
    mkdirSync(join(praanaHome, APP_HOME_DIR), { recursive: true });
    prevHome = process.env.PRAANA_HOME;
    prevCwd = process.cwd();
    process.env.PRAANA_HOME = praanaHome;
    process.chdir(projectDir);
    setAppLogger(
      new PraanaLogger({ domain: "app", writeLine: () => {} }),
    );
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
    rmSync(praanaHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("appends shell.allowed_paths across global and local config files", () => {
    writeFileSync(
      join(praanaHome, APP_HOME_DIR, "config.toml"),
      '[shell]\nenabled = true\nallowed_paths = ["/global", "/shared"]\n',
      "utf-8",
    );
    writeFileSync(
      join(projectDir, "praana.config.toml"),
      '[shell]\nallowed_paths = ["/project", "/shared"]\n',
      "utf-8",
    );

    const config = loadConfig();
    expect(config.shell.enabled).toBe(true);
    expect(config.shell.allowed_paths).toEqual([
      "/global",
      "/shared",
      "/project",
    ]);
    const sources = getLoadedConfigSources();
    expect(sources.some((s) => s.endsWith("config.toml"))).toBe(true);
    expect(sources.some((s) => s.endsWith("praana.config.toml"))).toBe(true);
  });
});

describe("config loading", () => {
  let root: string;
  let logLines: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-config-test-"));
    logLines = [];
    setAppLogger(
      new PraanaLogger({ domain: "app", writeLine: (line) => logLines.push(line) }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("captures parser warnings and includes CONFIG_INVALID in logs", () => {
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, "[llm\nprovider = \"openrouter\"\n", "utf-8");

    loadConfig(configPath);
    const warnings = getConfigWarnings();

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("Failed to parse TOML"))).toBe(true);
    expect(getLoadedConfigSources()).toHaveLength(0);
    expect(logLines.some((l) => l.includes("CONFIG_INVALID"))).toBe(true);
  });

  it("parses fallback_provider and fallback_model under [llm]", () => {
    const configPath = join(root, "fallback.toml");
    writeFileSync(
      configPath,
      '[llm]\nprovider = "umans"\nmodel = "umans-coder"\nfallback_provider = "openrouter"\nfallback_model = "moonshotai/kimi-k2.7-code"\n',
      "utf-8",
    );

    const config = loadConfig(configPath);
    expect(config.llm.fallback_provider).toBe("openrouter");
    expect(config.llm.fallback_model).toBe("moonshotai/kimi-k2.7-code");
    expect(getConfigWarnings()).toHaveLength(0);
  });

  it("warns when only one fallback key is set", () => {
    const configPath = join(root, "partial-fallback.toml");
    writeFileSync(
      configPath,
      '[llm]\nprovider = "umans"\nmodel = "umans-coder"\nfallback_provider = "openrouter"\n',
      "utf-8",
    );

    loadConfig(configPath);
    const warnings = getConfigWarnings();
    expect(warnings.some((w) =>
      w.includes("fallback_provider") && w.includes("fallback_model"),
    )).toBe(true);
  });

  it("defaults block_repeat_reads to true", () => {
    const config = loadConfig(join(root, "missing.toml"));
    expect(config.tools.block_repeat_reads).toBe(true);
  });

  it("allows block_repeat_reads to be explicitly set to false", () => {
    const configPath = join(root, "soft.toml");
    writeFileSync(configPath, "[tools]\nblock_repeat_reads = false\n", "utf-8");
    const config = loadConfig(configPath);
    expect(config.tools.block_repeat_reads).toBe(false);
  });

  it("warnings reflect the most recent loadConfig() call", () => {
    const goodConfig = join(root, "good.toml");
    const badConfig = join(root, "bad.toml");
    writeFileSync(goodConfig, '[llm]\nprovider = "openrouter"\nmodel = "m"\n', "utf-8");
    writeFileSync(badConfig, "[llm\n", "utf-8");

    loadConfig(goodConfig);
    expect(getConfigWarnings()).toHaveLength(0);

    loadConfig(badConfig);
    const warnings = getConfigWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("Failed to parse TOML"))).toBe(true);
  });
});
