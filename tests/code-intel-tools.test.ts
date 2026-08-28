import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodeIntelTools } from "../src/tools/code-intel.js";
import { loadNative, resetNativeLoadCache } from "../src/native/index.js";
import { stubNativeBindings } from "./helpers/native-bindings.js";

describe("code-intel tools", () => {
  let fixtureDir: string;

  beforeEach(() => {
    resetNativeLoadCache();
    fixtureDir = join(
      tmpdir(),
      `praana-code-intel-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(fixtureDir, { recursive: true });
  });

  afterEach(() => {
    resetNativeLoadCache();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("soft-fails when native bindings are unavailable", async () => {
    const tools = createCodeIntelTools({
      cwd: fixtureDir,
      getNative: async () => null,
    });
    const result = await tools.code_symbols.execute({ path: "a.ts" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unavailable");
    expect(result.error).toContain("native unavailable");
  });

  it("rejects missing files", async () => {
    const mock = stubNativeBindings({
      nativeVersion: () => "0.2.0",
      parseFile: () => ({ ok: true, language: "typescript", diagnostics: [] }),
      listSymbols: () => ({ ok: true, language: "typescript", symbols: [] }),
      listImports: () => ({ ok: true, language: "typescript", imports: [] }),
    });
    const tools = createCodeIntelTools({
      cwd: fixtureDir,
      getNative: async () => mock,
    });
    const result = await tools.code_symbols.execute({ path: "missing.ts" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("io_error");
  });

  it("enforces sandbox allowed_paths", async () => {
    const mock = stubNativeBindings({
      nativeVersion: () => "0.2.0",
      parseFile: () => ({ ok: true, language: "typescript", diagnostics: [] }),
      listSymbols: () => ({ ok: true, language: "typescript", symbols: [] }),
      listImports: () => ({ ok: true, language: "typescript", imports: [] }),
    });
    const allowed = join(fixtureDir, "allowed");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "ok.ts"), "export const x = 1;\n");
    writeFileSync(join(fixtureDir, "blocked.ts"), "export const y = 1;\n");

    const tools = createCodeIntelTools({
      cwd: fixtureDir,
      sandbox: { enabled: true, allowed_paths: [allowed] },
      getNative: async () => mock,
    });

    const blocked = await tools.code_symbols.execute({ path: "blocked.ts" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("sandbox");

    const ok = await tools.code_symbols.execute({ path: "allowed/ok.ts" });
    expect(ok.ok).toBe(true);
  });

  it("lists symbols via real native addon when available", async () => {
    const loaded = await loadNative({ forceReload: true });
    if (!loaded.available || !loaded.bindings) {
      if (process.env.PRAANA_REQUIRE_NATIVE === "1") {
        expect(loaded.available).toBe(true);
      }
      return; // soft-skip when addon not built in this environment
    }
    writeFileSync(
      join(fixtureDir, "sample.ts"),
      "export function alpha() { return 1; }\nexport class Beta {}\n",
    );
    writeFileSync(
      join(fixtureDir, "sample.rs"),
      "pub fn rust_alpha() {}\nfn rust_beta() {}\n",
    );
    const tools = createCodeIntelTools({ cwd: fixtureDir });
    const symbols = await tools.code_symbols.execute({ path: "sample.ts" });
    expect(symbols.ok).toBe(true);
    if (!symbols.ok) return;
    const names = symbols.symbols.map((s: { name: string }) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("Beta");

    const imports = await tools.code_imports.execute({ path: "sample.ts" });
    expect(imports.ok).toBe(true);

    const parsed = await tools.code_parse.execute({ path: "sample.ts" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.language).toBe("typescript");
    }

    const defs = await tools.code_definition.execute({
      symbol: "alpha",
      root: ".",
    });
    expect(defs.ok).toBe(true);
    if (!defs.ok) return;
    expect(defs.hits.some((h: { name: string }) => h.name === "alpha")).toBe(
      true,
    );

    const refs = await tools.code_references.execute({
      symbol: "alpha",
      root: ".",
    });
    expect(refs.ok).toBe(true);
    if (refs.ok) {
      expect(refs.hits.some((h: { name: string }) => h.name === "alpha")).toBe(
        true,
      );
    }

    const rustSymbols = await tools.code_symbols.execute({ path: "sample.rs" });
    expect(rustSymbols.ok).toBe(true);
    if (!rustSymbols.ok) return;
    const rustNames = rustSymbols.symbols.map((s: { name: string }) => s.name);
    expect(rustNames).toContain("rust_alpha");
    const rustAlpha = rustSymbols.symbols.find(
      (s: { name: string }) => s.name === "rust_alpha",
    );
    expect(rustAlpha?.exported).toBe(true);
  });
});
