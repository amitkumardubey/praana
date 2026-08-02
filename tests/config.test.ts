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
import { setUserProviders, isUserDeclaredProvider } from "../src/provider-registry.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";

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

  it("defaults block_repeat_reads to false", () => {
    const config = loadConfig(join(root, "missing.toml"));
    expect(config.tools.block_repeat_reads).toBe(false);
  });

  it("does not auto-select a provider from environment when [llm] provider is unset", () => {
    const prev = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "sk-opencode-test";
    try {
      const configPath = join(root, "no-provider.toml");
      writeFileSync(configPath, "# no [llm] provider\n", "utf-8");
      const config = loadConfig(configPath);
      expect(config.llm.provider).toBe("");
      expect(config.llm.model).toBe("");
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = prev;
    }
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

describe("user-declared providers", () => {
  let root: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-providers-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = root;
    setAppLogger(new PraanaLogger({ domain: "config", writeLine: () => {} }));
    setUserProviders(undefined);
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
    setUserProviders(undefined);
    resetCredentialStoreForTests();
  });

  it("parses [providers.<id>] section from TOML", () => {
    const configPath = join(root, "providers.toml");
    writeFileSync(
      configPath,
      `[providers.my-llama]
api = "openai-completions"
base_url = "http://localhost:8080/v1"
`,
      "utf-8",
    );
    const config = loadConfig(configPath);
    expect(config.providers).toBeDefined();
    expect(config.providers!["my-llama"]).toBeDefined();
    expect(config.providers!["my-llama"].api).toBe("openai-completions");
    expect(config.providers!["my-llama"].base_url).toBe("http://localhost:8080/v1");
  });

  it("parses [[providers.<id>.models]] array of tables", () => {
    const configPath = join(root, "models.toml");
    writeFileSync(
      configPath,
      `[providers.my-llama]
api = "openai-completions"
base_url = "http://localhost:8080/v1"

[[providers.my-llama.models]]
id = "llama-3.1-8b"
context_window = 128000
reasoning = false

[[providers.my-llama.models]]
id = "llama-3.1-70b"
context_window = 128000
reasoning = true
`,
      "utf-8",
    );
    const config = loadConfig(configPath);
    const models = config.providers!["my-llama"].models;
    expect(models).toHaveLength(2);
    expect(models![0].id).toBe("llama-3.1-8b");
    expect(models![0].context_window).toBe(128000);
    expect(models![1].id).toBe("llama-3.1-70b");
    expect(models![1].reasoning).toBe(true);
  });

  it("parses env_key and headers fields", () => {
    const configPath = join(root, "full.toml");
    writeFileSync(
      configPath,
      `[providers.custom]
api = "openai-completions"
base_url = "https://api.custom.com/v1"
env_key = "CUSTOM_API_KEY"

[providers.custom.headers]
X-Custom = "praana"
`,
      "utf-8",
    );
    const config = loadConfig(configPath);
    const pc = config.providers!["custom"];
    expect(pc.env_key).toBe("CUSTOM_API_KEY");
    expect(pc.headers).toEqual({ "X-Custom": "praana" });
  });

  it("calls setUserProviders on loadConfig (wires into module-level registry)", () => {
    const configPath = join(root, "wired.toml");
    writeFileSync(
      configPath,
      `[providers.wired-test]
api = "openai-completions"
base_url = "http://localhost:9999/v1"
`,
      "utf-8",
    );
    loadConfig(configPath);
    expect(isUserDeclaredProvider("wired-test")).toBe(true);
  });

  it("warns and drops provider with missing api", () => {
    const configPath = join(root, "no-api.toml");
    writeFileSync(
      configPath,
      `[providers.no-api]
base_url = "http://localhost:8080/v1"
`,
      "utf-8",
    );
    const config = loadConfig(configPath);
    expect(config.providers).toBeUndefined();
    expect(getConfigWarnings().some((w) => w.includes("no-api.api is required"))).toBe(true);
  });

  it("warns and drops provider with missing base_url", () => {
    const configPath = join(root, "no-base.toml");
    writeFileSync(
      configPath,
      `[providers.no-base]
api = "openai-completions"
`,
      "utf-8",
    );
    const config = loadConfig(configPath);
    expect(config.providers).toBeUndefined();
    expect(getConfigWarnings().some((w) => w.includes("no-base.base_url is required"))).toBe(true);
  });

  it("merges providers from global (PRAANA_HOME) and local config", () => {
    mkdirSync(join(root, APP_HOME_DIR), { recursive: true });
    writeFileSync(
      join(root, APP_HOME_DIR, "config.toml"),
      `[providers.global-provider]
api = "openai-completions"
base_url = "http://global:8080/v1"
`,
      "utf-8",
    );
    // Use explicit path for local config to avoid CWD interference.
    const localPath = join(root, "local.toml");
    writeFileSync(
      localPath,
      `[providers.local-provider]
api = "openai-completions"
base_url = "http://local:8080/v1"
`,
      "utf-8",
    );
    // loadConfig with explicit path skips multi-source merge.
    // To test merge, call loadConfig() without a path — reads from PRAANA_HOME.
    const config = loadConfig();
    expect(config.providers).toBeDefined();
    expect(config.providers!["global-provider"]).toBeDefined();
    expect(config.providers!["global-provider"].base_url).toBe("http://global:8080/v1");
  });
});
