import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectContext } from "../src/session.js";

describe("buildProjectContext", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `aria-test-project-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null for empty directory", () => {
    expect(buildProjectContext(testDir)).toBeNull();
  });

  it("parses package.json with all fields", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        description: "A cool app",
        scripts: { build: "tsc", start: "node dist/main.js" },
        dependencies: { react: "^18.0.0", lodash: "^4.17.0" },
      })
    );

    const result = buildProjectContext(testDir);
    expect(result).toContain("Project: my-app");
    expect(result).toContain("Description: A cool app");
    expect(result).toContain("Scripts: build, start");
    expect(result).toContain("Dependencies: react, lodash");
  });

  it("handles package.json with only name", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "minimal-pkg" })
    );

    const result = buildProjectContext(testDir);
    expect(result).toContain("Project: minimal-pkg");
    expect(result).not.toContain("Description:");
    expect(result).not.toContain("Scripts:");
    expect(result).not.toContain("Dependencies:");
  });

  it("truncates dependencies list at 10", () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      deps[`dep-${i}`] = "^1.0.0";
    }
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "many-deps", dependencies: deps })
    );

    const result = buildProjectContext(testDir)!;
    expect(result).toContain("...");
    // Should list exactly 10 deps
    const depsMatch = result.match(/Dependencies: (.+)/);
    expect(depsMatch).toBeTruthy();
    const depList = depsMatch![1].replace("...", "").trim();
    expect(depList.split(", ").length).toBe(10);
  });

  it("logs warning on malformed package.json", () => {
    writeFileSync(join(testDir, "package.json"), "{ invalid json }");

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    const result = buildProjectContext(testDir);
    console.warn = origWarn;

    // Should still return something (other checks may pass) or null
    // But should have logged a warning
    expect(warnings.some((w) => w.includes("Failed to parse package.json"))).toBe(true);
  });

  it("detects TypeScript from tsconfig.json", () => {
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Language: TypeScript");
  });

  it("detects Python from pyproject.toml", () => {
    writeFileSync(join(testDir, "pyproject.toml"), "[project]\nname = 'test'");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Language: Python");
  });

  it("detects Go from go.mod", () => {
    writeFileSync(join(testDir, "go.mod"), "module myproject\n\ngo 1.21");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Language: Go");
  });

  it("detects Rust from Cargo.toml", () => {
    writeFileSync(join(testDir, "Cargo.toml"), "[package]\nname = \"mycrate\"");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Language: Rust");
  });

  it("detects Ruby from Gemfile", () => {
    writeFileSync(join(testDir, "Gemfile"), 'source "https://rubygems.org"');

    const result = buildProjectContext(testDir);
    expect(result).toContain("Language: Ruby");
  });

  it("reports first matching language only (polyglot)", () => {
    writeFileSync(join(testDir, "tsconfig.json"), "{}");
    writeFileSync(join(testDir, "pyproject.toml"), "[project]");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Language: TypeScript");
    expect(result).not.toContain("Language: Python");
  });

  it("detects .gitignore", () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\n");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Has .gitignore");
  });

  it("does not include .gitignore when absent", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = buildProjectContext(testDir);
    expect(result).not.toContain("Has .gitignore");
  });

  it("includes README.md content (first 50 lines)", () => {
    const readmeLines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: Some content`);
    writeFileSync(join(testDir, "README.md"), readmeLines.join("\n"));

    const result = buildProjectContext(testDir);
    expect(result).toContain("README:");
    expect(result).toContain("Line 1: Some content");
    expect(result).toContain("Line 20: Some content");
  });

  it("truncates README to 50 lines", () => {
    const readmeLines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(join(testDir, "README.md"), readmeLines.join("\n"));
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = buildProjectContext(testDir)!;
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 50");
    expect(result).not.toContain("Line 51");
  });

  it("skips empty README", () => {
    writeFileSync(join(testDir, "README.md"), "\n\n\n");
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));

    const result = buildProjectContext(testDir);
    // README with only whitespace should not add a README: line
    expect(result).not.toContain("README:");
  });

  it("caps summary at 500 chars with ellipsis", () => {
    const longDescription = "x".repeat(600);
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "big-project", description: longDescription })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");
    writeFileSync(join(testDir, ".gitignore"), "");
    writeFileSync(join(testDir, "README.md"), "A".repeat(200));

    const result = buildProjectContext(testDir)!;
    expect(result.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("uses newline separator for readability", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "readable" })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Project: readable\nLanguage: TypeScript");
  });

  it("combines all signals in a full project", () => {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "full-project",
        description: "A full project",
        scripts: { test: "vitest" },
        dependencies: { vitest: "^1.0.0" },
      })
    );
    writeFileSync(join(testDir, "tsconfig.json"), "{}");
    writeFileSync(join(testDir, ".gitignore"), "dist/\n");
    writeFileSync(join(testDir, "README.md"), "# Full Project\n\nA great project.");

    const result = buildProjectContext(testDir);
    expect(result).toContain("Project: full-project");
    expect(result).toContain("Description: A full project");
    expect(result).toContain("Scripts: test");
    expect(result).toContain("Dependencies: vitest");
    expect(result).toContain("Language: TypeScript");
    expect(result).toContain("Has .gitignore");
    expect(result).toContain("README: # Full Project");
  });
});
