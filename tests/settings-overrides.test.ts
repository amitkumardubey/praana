import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";

const api = () => import("../src/settings/overrides.js");

describe("settings config_overrides ingestion", () => {
  test("every approved path exists in DEFAULT_CONFIG and accepts valid values", async () => {
    const { APPROVED_CONFIG_OVERRIDES, parseConfigOverrides, expandOverrides } = await api();
    const defaultConfig = loadConfig("/nonexistent-praana-config.toml");

    const expectedPaths = [
      "edit.confirm",
      "tools.block_repeat_reads",
      "lsp.enabled",
      "lsp.diagnostics",
      "lsp.format_on_edit",
      "verify.enabled",
      "verify.syntax",
      "verify.typecheck",
      "verify.tests",
      "turn.pause_after_steps",
      "ui.ambient",
      "ui.tool_icons",
      "ui.syntax_theme",
      "ui.show_cost",
      "ui.markdown_rendering",
      "ui.syntax_highlighting",
    ];
    expect(Object.keys(APPROVED_CONFIG_OVERRIDES).sort()).toEqual([...expectedPaths].sort());

    for (const dotted of expectedPaths) {
      const segments = dotted.split(".");
      let cursor: unknown = defaultConfig;
      for (const seg of segments) {
        expect(cursor).toBeDefined();
        expect(typeof cursor).toBe("object");
        cursor = (cursor as Record<string, unknown>)[seg];
      }
      expect(cursor).not.toBeUndefined();
    }

    const validInput: Record<string, unknown> = {
      "edit.confirm": true,
      "tools.block_repeat_reads": true,
      "lsp.enabled": true,
      "lsp.diagnostics": false,
      "lsp.format_on_edit": true,
      "verify.enabled": true,
      "verify.syntax": false,
      "verify.typecheck": true,
      "verify.tests": false,
      "turn.pause_after_steps": 100,
      "ui.ambient": "quiet",
      "ui.tool_icons": "ascii",
      "ui.syntax_theme": "dracula",
      "ui.show_cost": false,
      "ui.markdown_rendering": false,
      "ui.syntax_highlighting": true,
    };

    const parsed = parseConfigOverrides(validInput);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.accepted).toEqual(validInput);

    const expanded = expandOverrides(parsed.accepted);
    expect(expanded).toEqual({
      ok: true,
      value: {
        edit: { confirm: true },
        tools: {
          block_repeat_reads: true,
        },
        lsp: { enabled: true, diagnostics: false, format_on_edit: true },
        verify: { enabled: true, syntax: false, typecheck: true, tests: false },
        turn: { pause_after_steps: 100 },
        ui: {
          ambient: "quiet",
          tool_icons: "ascii",
          syntax_theme: "dracula",
          show_cost: false,
          markdown_rendering: false,
          syntax_highlighting: true,
        },
      },
    });
  });

  test("rejects wrong types, string-to-boolean coercion, out-of-range ints, and bad enums", async () => {
    const { parseConfigOverrides } = await api();
    const badInputs: Record<string, unknown> = {
      "edit.confirm": "true",
      "tools.block_repeat_reads": 1,
      "lsp.enabled": null,
      "verify.enabled": { nested: true },
      "turn.pause_after_steps": 0,
      "ui.ambient": "loud",
      "ui.tool_icons": "emoji",
      "ui.syntax_theme": "   ",
    };

    const res = parseConfigOverrides(badInputs);
    expect(res.accepted).toEqual({});
    expect(res.rejected.map((r) => r.path).sort()).toEqual(Object.keys(badInputs).sort());
    for (const item of res.rejected) {
      expect(item.reason.length).toBeGreaterThan(0);
    }

    // Boundary checks on turn.pause_after_steps (1..1000)
    expect(parseConfigOverrides({ "turn.pause_after_steps": 1 }).accepted).toEqual({ "turn.pause_after_steps": 1 });
    expect(parseConfigOverrides({ "turn.pause_after_steps": 1000 }).accepted).toEqual({ "turn.pause_after_steps": 1000 });
    expect(parseConfigOverrides({ "turn.pause_after_steps": 1001 }).rejected[0]?.path).toBe("turn.pause_after_steps");
    expect(parseConfigOverrides({ "turn.pause_after_steps": -5 }).rejected[0]?.path).toBe("turn.pause_after_steps");
    expect(parseConfigOverrides({ "turn.pause_after_steps": 10.5 }).rejected[0]?.path).toBe("turn.pause_after_steps");
  });

  test("rejects forbidden security-sensitive paths, empty segments, symbol keys, and non-object roots", async () => {
    const { parseConfigOverrides } = await api();
    const forbidden = [
      "risk.allow",
      "shell.allowed_paths",
      "shell.enabled",
      "llm.model",
      "llm.provider",
      "llm.base_url",
      "providers.openai.base_url",
      "lsp.servers",
      "lsp.servers.ts.command",
      "lsp.servers.ts.args",
      "",
      ".edit.confirm",
      "edit.confirm.",
      "edit..confirm",
    ];
    const input: Record<string, unknown> = {};
    for (const key of forbidden) input[key] = true;
    const sym = Symbol("secret");
    (input as Record<symbol, unknown>)[sym] = true;

    const parsed = parseConfigOverrides(input);
    expect(parsed.accepted).toEqual({});
    expect(parsed.rejected.map((r) => r.path)).toEqual([...forbidden, "Symbol(secret)"]);

    for (const nonObject of [null, [], "string", 123, true]) {
      const badRoot = parseConfigOverrides(nonObject);
      expect(badRoot.accepted).toEqual({});
      expect(badRoot.rejected).toEqual([{ path: "config_overrides", reason: expect.stringMatching(/plain object/i) }]);
    }
  });

  test("prevents prototype pollution in both parseConfigOverrides and direct expandOverrides calls", async () => {
    const { parseConfigOverrides, expandOverrides } = await api();

    const hostileJson = JSON.parse(
      '{"__proto__": {"polluted": "yes"}, "__proto__.polluted": "yes", "constructor.prototype.polluted": "yes", "ui.__proto__.polluted": "yes", "ui.prototype.polluted": "yes"}',
    );
    Object.defineProperty(hostileJson, "constructor", {
      value: { prototype: { polluted: "yes" } },
      enumerable: true,
      configurable: true,
    });

    const parsed = parseConfigOverrides(hostileJson);
    expect(parsed.accepted).toEqual({});
    expect(parsed.rejected.map((r) => r.path).sort()).toEqual([
      "__proto__",
      "__proto__.polluted",
      "constructor",
      "constructor.prototype.polluted",
      "ui.__proto__.polluted",
      "ui.prototype.polluted",
    ]);
    for (const item of parsed.rejected) {
      expect(item.reason).toMatch(/prototype|forbidden/i);
    }

    // Call expandOverrides directly with a hostile map bypassing parseConfigOverrides
    const directHostile = JSON.parse(
      '{"__proto__.polluted": true, "constructor.prototype.polluted": true, "ui.__proto__.polluted": true, "a..b": true, "edit.confirm": true}',
    );
    const expanded = expandOverrides(directHostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(expanded.ok).toBe(false);
  });

  test("rejects tools.web.allow_domains as unapproved", async () => {
    const { APPROVED_CONFIG_OVERRIDES, parseConfigOverrides } = await api();
    expect("tools.web.allow_domains" in APPROVED_CONFIG_OVERRIDES).toBe(false);
    const res = parseConfigOverrides({ "tools.web.allow_domains": ["example.com"] });
    expect(res.accepted).toEqual({});
    expect(res.rejected).toEqual([
      { path: "tools.web.allow_domains", reason: expect.stringMatching(/unapproved/i) },
    ]);
  });

  test("expandOverrides is order-independent, rejects prefix conflicts naming both keys, and rejects unapproved paths", async () => {
    const { expandOverrides } = await api();

    // 1. Dotted prefix conflict rejected identically in both key orders, naming both keys.
    const pairCases: Array<[Record<string, unknown>, Record<string, unknown>, string, string]> = [
      [{ a: 1, "a.b": 2 }, { "a.b": 2, a: 1 }, "a", "a.b"],
      [
        { ui: { ambient: "inline" }, "ui.ambient": "quiet" },
        { "ui.ambient": "quiet", ui: { ambient: "inline" } },
        "ui",
        "ui.ambient",
      ],
      [{ a: 1, "a.b.c": 2 }, { "a.b.c": 2, a: 1 }, "a", "a.b.c"],
    ];

    for (const [order1, order2, k1, k2] of pairCases) {
      const r1 = expandOverrides(order1);
      const r2 = expandOverrides(order2);
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(false);
      if (!r1.ok && !r2.ok) {
        expect(r1.error).toContain(k1);
        expect(r1.error).toContain(k2);
        expect(r2.error).toContain(k1);
        expect(r2.error).toContain(k2);
        expect(r1.error).toBe(r2.error);
      }
    }

    // 2. Unapproved paths are rejected by expandOverrides even without prefix conflicts.
    for (const badPath of ["a.b", "risk.allow", "unknown.key", "edit.confirm.extra"]) {
      const res = expandOverrides({ [badPath]: true });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain(badPath);
      }
    }

    // 3. Valid overrides produce identical output regardless of key order.
    const forward = expandOverrides({ "ui.ambient": "quiet", "edit.confirm": true, "ui.show_cost": false });
    const reverse = expandOverrides({ "ui.show_cost": false, "edit.confirm": true, "ui.ambient": "quiet" });
    expect(forward).toEqual(reverse);
    expect(forward).toEqual({
      ok: true,
      value: {
        edit: { confirm: true },
        ui: { ambient: "quiet", show_cost: false },
      },
    });
  });

  test("ui.syntax_theme trims accepted values and enforces a 64-character maximum length", async () => {
    const { parseConfigOverrides } = await api();

    const padded = parseConfigOverrides({ "ui.syntax_theme": "  dracula  " });
    expect(padded.rejected).toEqual([]);
    expect(padded.accepted).toEqual({ "ui.syntax_theme": "dracula" });

    const maxValid = "t".repeat(64);
    const atLimit = parseConfigOverrides({ "ui.syntax_theme": `  ${maxValid}  ` });
    expect(atLimit.rejected).toEqual([]);
    expect(atLimit.accepted).toEqual({ "ui.syntax_theme": maxValid });

    const overLimit = parseConfigOverrides({ "ui.syntax_theme": "t".repeat(65) });
    expect(overLimit.accepted).toEqual({});
    expect(overLimit.rejected).toEqual([
      { path: "ui.syntax_theme", reason: expect.stringMatching(/64/) },
    ]);
  });
});
