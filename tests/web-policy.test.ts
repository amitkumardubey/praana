import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopExempt } from "../src/circuit/loop-gate.js";
import { deepMerge, getConfigWarnings, loadConfig } from "../src/config.js";
import { createRiskPreToolCallHandler } from "../src/hooks/handlers/risk.js";
import type { HookSessionLike } from "../src/hooks/types.js";
import { isPlanModeMutatingTool } from "../src/plan-mode.js";
import { redactSecrets } from "../src/redact/secrets.js";
import { classifyRisk } from "../src/risk/classify.js";
import { formatWebFetchPrompt } from "../src/risk/prompt.js";
import { createAllTools, describeTools } from "../src/tools/index.js";
import { DEFAULT_WEB_CONFIG, decideWebHost, hostMatchesDomain, normalizeDomainRule } from "../src/tools/web/policy.js";
import { createWebFetchTool } from "../src/tools/web/tool.js";
import type { WebFetchOptions, WebFetchResult } from "../src/tools/web/fetch.js";

const URL_WITH_SECRETS =
  "https://example.com/docs/a?page=1&token=sekrit&api_key=abc&Key=nope&secret=s&password=p&sig=g&auth=h&access_token=t";

const REDACTED =
  "https://example.com/docs/a?page=1&token=[REDACTED]&api_key=[REDACTED]&Key=[REDACTED]&secret=[REDACTED]&password=[REDACTED]&sig=[REDACTED]&auth=[REDACTED]&access_token=[REDACTED]";

function webSession(opts: {
  policy: "disabled" | "deny" | "allow" | "confirm";
  remembered?: Set<string>;
  confirm?: HookSessionLike["confirmRisk"];
}): HookSessionLike & { prompts: string[] } {
  const remembered = opts.remembered ?? new Set<string>();
  const prompts: string[] = [];
  const session: HookSessionLike = {
    cwd: "/proj",
    isPlanMode: () => false,
    webFetchPolicy: () => opts.policy,
    webFetchHostRemembered: (host) => remembered.has(host),
    rememberWebFetchHost: (host) => {
      remembered.add(host);
    },
    confirmRisk:
      opts.confirm ??
      (async (_classId, prompt) => {
        prompts.push(prompt);
        return { allowed: true };
      }),
  };
  return Object.assign(session, { prompts });
}

const okPage = async (): Promise<WebFetchResult> => ({
  ok: true,
  url: "https://example.com/a",
  final_url: "https://example.com/a",
  status: 200,
  content_type: "text/plain",
  truncated: false,
  bytes: 2,
  content: "ok",
});

describe("web_fetch risk, config, and redaction", () => {
  it("classifies a fetch and redacts sensitive query values", () => {
    const hit = classifyRisk("web_fetch", { url: URL_WITH_SECRETS }, "/proj");
    expect(hit?.class).toBe("web_fetch_host");
    expect(hit?.detail).toBe(REDACTED);
    expect(hit?.detail).not.toContain("sekrit");
    expect(formatWebFetchPrompt(hit!.detail)).toBe(`Fetch ${REDACTED}? [y/N]`);
  });

  it("does not classify a non-http url", () => {
    expect(classifyRisk("web_fetch", { url: "file:///etc/passwd" }, "/proj")).toBeNull();
  });

  it("matches a domain on a dot boundary and lets deny win", () => {
    expect(hostMatchesDomain("example.com", "example.com")).toBe(true);
    expect(hostMatchesDomain("a.example.com", "example.com")).toBe(true);
    expect(hostMatchesDomain("notexample.com", "example.com")).toBe(false);
    expect(hostMatchesDomain("EXAMPLE.com.", "example.com")).toBe(true);
    const listed = {
      ...DEFAULT_WEB_CONFIG,
      allow_domains: ["example.com"],
      deny_domains: ["secret.example.com"],
    };
    expect(decideWebHost("secret.example.com", listed)).toBe("deny");
    expect(decideWebHost("www.example.com", listed)).toBe("allow");
    expect(decideWebHost("other.org", listed)).toBe("deny");
    expect(decideWebHost("other.org", DEFAULT_WEB_CONFIG)).toBe("confirm");
    expect(
      decideWebHost("evil.example.com", { ...DEFAULT_WEB_CONFIG, deny_domains: ["example.com"] }),
    ).toBe("deny");
  });

  it("loads [tools.web] with defaults and warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-web-cfg-"));
    try {
      const bare = join(dir, "bare.toml");
      writeFileSync(bare, '[llm]\nprovider = "openrouter"\n', "utf-8");
      const defaults = loadConfig(bare);
      expect(defaults.tools.web.enabled).toBe(true);
      expect(defaults.tools.web.allow_domains).toEqual([]);
      expect(defaults.tools.web.deny_domains).toEqual([]);
      expect(defaults.tools.web.timeout_ms).toBe(15_000);
      expect(defaults.tools.web.max_chars).toBe(20_000);

      const path = join(dir, "web.toml");
      writeFileSync(
        path,
        [
          "[tools.web]",
          "enabled = true",
          'allow_domains = ["Example.COM", "*.docs.example.com", ""]',
          'deny_domains = ["bad.example.com"]',
          "timeout_ms = 5000",
          "max_chars = 1000",
          "",
        ].join("\n"),
        "utf-8",
      );
      const config = loadConfig(path);
      expect(config.tools.web.allow_domains).toEqual(["example.com", "docs.example.com"]);
      expect(config.tools.web.deny_domains).toEqual(["bad.example.com"]);
      expect(config.tools.web.timeout_ms).toBe(5000);
      expect(config.tools.web.max_chars).toBe(1000);

      const bad = join(dir, "bad.toml");
      writeFileSync(
        bad,
        [
          "[tools.web]",
          'enabled = "yes"',
          'allow_domains = "example.com"',
          "timeout_ms = -1",
          "max_chars = 999999",
          "",
        ].join("\n"),
        "utf-8",
      );
      const warned = loadConfig(bad);
      expect(warned.tools.web.enabled).toBe(true);
      expect(warned.tools.web.allow_domains).toEqual([]);
      expect(warned.tools.web.timeout_ms).toBe(15_000);
      expect(warned.tools.web.max_chars).toBe(20_000);
      const warnings = getConfigWarnings().join("\n");
      expect(warnings).toContain("tools.web.enabled");
      expect(warnings).toContain("tools.web.allow_domains");
      expect(warnings).toContain("tools.web.timeout_ms");
      expect(warnings).toContain("tools.web.max_chars");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces allow_domains instead of appending them", () => {
    const merged = deepMerge(
      { tools: { web: { allow_domains: ["a.com"] } } },
      { tools: { web: { allow_domains: ["b.com"] } } },
    );
    expect(merged.tools.web.allow_domains).toEqual(["b.com"]);
  });

  it("asks once per host, then remembers the host for the session", async () => {
    const remembered = new Set<string>();
    const session = webSession({ policy: "confirm", remembered });
    const pre = createRiskPreToolCallHandler("/proj");
    const args = { url: URL_WITH_SECRETS };
    const first = await pre({ toolName: "web_fetch", args, session });
    expect(first).toBeUndefined();
    expect(session.prompts).toEqual([`Fetch ${REDACTED}? [y/N]`]);
    expect(remembered.has("example.com")).toBe(true);
    const second = await pre({ toolName: "web_fetch", args, session });
    expect(second).toBeUndefined();
    expect(session.prompts).toHaveLength(1);
  });

  it("skips the prompt when the host is on allow_domains", async () => {
    const session = webSession({ policy: "allow" });
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "web_fetch",
      args: { url: "https://example.com/a" },
      session,
    });
    expect(out).toBeUndefined();
    expect(session.prompts).toHaveLength(0);
  });

  it("blocks a denied or disabled host without asking", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const denied = await pre({
      toolName: "web_fetch",
      args: { url: "https://secret.example.com/a" },
      session: webSession({ policy: "deny" }),
    });
    expect(denied?.action).toBe("block");
    if (denied && denied.action === "block") {
      expect(denied.error).toContain("secret.example.com");
      expect(denied.error).toContain("tools.web");
    }
    const disabled = await pre({
      toolName: "web_fetch",
      args: { url: "https://example.com/a" },
      session: webSession({ policy: "disabled" }),
    });
    expect(disabled?.action).toBe("block");
    if (disabled && disabled.action === "block") {
      expect(disabled.error).toContain("disabled");
    }
  });

  it("blocks a headless confirm and a TTY decline", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const headless = await pre({
      toolName: "web_fetch",
      args: { url: "https://example.com/docs/a?token=sekrit" },
      session: webSession({
        policy: "confirm",
        confirm: async () => ({ allowed: false, reason: "headless" }),
      }),
    });
    expect(headless?.action).toBe("block");
    if (headless && headless.action === "block") {
      expect(headless.error).toContain("web_fetch_host");
      expect(headless.error).toContain("allow_domains");
      expect(headless.error).toContain("[risk].allow");
      expect(headless.error).not.toContain("sekrit");
    }
    const declined = await pre({
      toolName: "web_fetch",
      args: { url: "https://example.com/docs/a?token=sekrit" },
      session: webSession({
        policy: "confirm",
        confirm: async () => ({ allowed: false, reason: "declined" }),
      }),
    });
    expect(declined?.action).toBe("block");
    if (declined && declined.action === "block") {
      expect(declined.error).toContain("User declined web_fetch_host");
      expect(declined.error).toContain("token=[REDACTED]");
      expect(declined.error).not.toContain("sekrit");
    }
  });

  it("redacts sensitive query values in logged strings and objects", () => {
    expect(redactSecrets("see https://example.com/a?token=sekrit&page=1")).toBe(
      "see https://example.com/a?token=[REDACTED]&page=1",
    );
    expect(redactSecrets({ url: "https://example.com/?password=p&sig=s" })).toEqual({
      url: "https://example.com/?password=[REDACTED]&sig=[REDACTED]",
    });
  });

  it("treats web_fetch as a read in plan mode and in the loop gate", () => {
    expect(isPlanModeMutatingTool("web_fetch", { url: "https://example.com" })).toBe(false);
    expect(isLoopExempt("web_fetch", { url: "https://example.com" })).toBe(true);
  });

  it("advertises web_fetch in both compile modes", () => {
    for (const classicMode of [true, false]) {
      expect(describeTools({ classicMode }).some((line) => line.startsWith("web_fetch("))).toBe(true);
      const tools = createAllTools({
        eventLog: {} as never,
        stateGraph: {} as never,
        memoryStore: null,
        memoryEnabled: false,
        incognito: false,
        contextEngine: null,
        cwd: "/proj",
        skills: [],
        skillRuntime: null,
        classicMode,
      });
      expect(tools.web_fetch).toBeDefined();
    }
  });

  it("refuses a denied, disabled, or unconfirmed host before fetching", async () => {
    const denied = createWebFetchTool({
      getWebConfig: () => ({ ...DEFAULT_WEB_CONFIG, deny_domains: ["example.com"] }),
      hostRemembered: () => true,
      fetchPage: async () => {
        throw new Error("should not fetch a denied host");
      },
    });
    const deniedResult = await denied.web_fetch.execute({ url: "https://www.example.com/a" });
    expect(deniedResult.ok).toBe(false);
    expect(deniedResult.reason).toContain("example.com");

    const disabled = createWebFetchTool({
      getWebConfig: () => ({ ...DEFAULT_WEB_CONFIG, enabled: false }),
      fetchPage: async () => {
        throw new Error("should not fetch when disabled");
      },
    });
    const disabledResult = await disabled.web_fetch.execute({ url: "https://example.com/a" });
    expect(disabledResult.ok).toBe(false);
    expect(disabledResult.reason).toContain("disabled");

    const headless = createWebFetchTool({
      getWebConfig: () => DEFAULT_WEB_CONFIG,
      headless: true,
      hostRemembered: () => false,
      riskAllow: [],
      fetchPage: async () => {
        throw new Error("should not fetch");
      },
    });
    const headlessResult = await headless.web_fetch.execute({ url: "https://example.com/a" });
    expect(headlessResult.ok).toBe(false);
    expect(headlessResult.reason).toContain("web_fetch_host");
  });

  it("fetches a pre-approved host with the configured timeout and max_chars", async () => {
    let seen: WebFetchOptions | undefined;
    const tool = createWebFetchTool({
      getWebConfig: () => ({
        ...DEFAULT_WEB_CONFIG,
        allow_domains: ["example.com"],
        timeout_ms: 1234,
        max_chars: 50,
      }),
      headless: true,
      fetchPage: async (_url, opts) => {
        seen = opts;
        return okPage();
      },
    });
    const result = await tool.web_fetch.execute({ url: "https://example.com/a", focus: "docs" });
    expect(result.ok).toBe(true);
    expect(seen?.timeoutMs).toBe(1234);
    expect(seen?.maxChars).toBe(50);
    expect(seen?.focus).toBe("docs");

    const overridden = createWebFetchTool({
      getWebConfig: () => ({ ...DEFAULT_WEB_CONFIG, max_chars: 50, allow_domains: ["example.com"] }),
      fetchPage: async (_url, opts) => {
        seen = opts;
        return okPage();
      },
    });
    await overridden.web_fetch.execute({ url: "https://example.com/a", max_chars: 80 });
    expect(seen?.maxChars).toBe(80);
  });

  it("blocks the punycode host when a deny rule is written in Unicode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-web-idna-"));
    try {
      const path = join(dir, "web.toml");
      writeFileSync(path, '[tools.web]\ndeny_domains = ["münchen.de"]\n', "utf-8");
      const config = loadConfig(path);
      expect(config.tools.web.deny_domains).toEqual(["xn--mnchen-3ya.de"]);
      expect(decideWebHost("xn--mnchen-3ya.de", config.tools.web)).toBe("deny");
      expect(decideWebHost("www.xn--mnchen-3ya.de", config.tools.web)).toBe("deny");
      expect(hostMatchesDomain("münchen.de", "xn--mnchen-3ya.de")).toBe(true);
      expect(hostMatchesDomain("www.münchen.de", "münchen.de")).toBe(true);
      expect(hostMatchesDomain("notxn--mnchen-3ya.de", "xn--mnchen-3ya.de")).toBe(false);

      const tool = createWebFetchTool({
        getWebConfig: () => config.tools.web,
        fetchPage: async () => {
          throw new Error("should not fetch a denied host");
        },
      });
      const puny = await tool.web_fetch.execute({ url: "https://xn--mnchen-3ya.de/a" });
      const unicode = await tool.web_fetch.execute({ url: "https://münchen.de/a" });
      expect(puny.ok).toBe(false);
      expect(unicode.ok).toBe(false);
      if (!puny.ok) expect(puny.reason).toContain("xn--mnchen-3ya.de");
      if (!unicode.ok) expect(unicode.reason).toContain("xn--mnchen-3ya.de");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes a mixed-case domain rule to punycode", () => {
    expect(normalizeDomainRule("München.DE")).toBe("xn--mnchen-3ya.de");
    expect(decideWebHost("xn--mnchen-3ya.de", { ...DEFAULT_WEB_CONFIG, deny_domains: ["München.DE"] })).toBe("deny");
  });

  it("normalizes a trailing dot on a domain rule", () => {
    expect(normalizeDomainRule("münchen.de.")).toBe("xn--mnchen-3ya.de");
    expect(hostMatchesDomain("München.DE.", "münchen.de.")).toBe(true);
    expect(hostMatchesDomain("xn--mnchen-3ya.de", "münchen.de.")).toBe(true);
  });

  it("treats a leading *. prefix as the punycode suffix", () => {
    expect(normalizeDomainRule("*.München.DE")).toBe("xn--mnchen-3ya.de");
    expect(
      decideWebHost("www.xn--mnchen-3ya.de", { ...DEFAULT_WEB_CONFIG, allow_domains: ["*.münchen.de"] }),
    ).toBe("allow");
    expect(
      decideWebHost("xn--mnchen-3ya.de", { ...DEFAULT_WEB_CONFIG, allow_domains: ["*.münchen.de"] }),
    ).toBe("allow");
    expect(
      decideWebHost("other.example", { ...DEFAULT_WEB_CONFIG, allow_domains: ["*.münchen.de"] }),
    ).toBe("deny");
  });

  it("fails closed when a domain rule cannot be normalised", () => {
    expect(normalizeDomainRule("foo\u0000.com")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "praana-web-idna-bad-"));
    try {
      const path = join(dir, "web.toml");
      writeFileSync(path, '[tools.web]\ndeny_domains = ["foo\\u0000.com", "münchen.de"]\n', "utf-8");
      const config = loadConfig(path);
      // The parseable rule is kept, but a malformed entry disables web_fetch
      // rather than silently dropping a deny rule and weakening the policy.
      expect(config.tools.web.deny_domains).toEqual(["xn--mnchen-3ya.de"]);
      expect(config.tools.web.enabled).toBe(false);
      const warnings = getConfigWarnings().join("\n");
      expect(warnings).toContain("tools.web.deny_domains");
      expect(warnings).toContain("foo");
      expect(warnings).toContain("disabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetches in headless when the risk class is allowed, and after the session remembers the host", async () => {
    let calls = 0;
    const headless = createWebFetchTool({
      getWebConfig: () => DEFAULT_WEB_CONFIG,
      headless: true,
      riskAllow: ["web_fetch_host"],
      fetchPage: async () => {
        calls += 1;
        return okPage();
      },
    });
    expect((await headless.web_fetch.execute({ url: "https://example.com/a" })).ok).toBe(true);

    const remembered = createWebFetchTool({
      getWebConfig: () => DEFAULT_WEB_CONFIG,
      hostRemembered: (host) => host === "example.com",
      fetchPage: async () => {
        calls += 1;
        return okPage();
      },
    });
    expect((await remembered.web_fetch.execute({ url: "https://example.com/a" })).ok).toBe(true);
    expect(calls).toBe(2);
  });
});
