import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveLspRoot, discoverWorkspaceMembers } from "../src/lsp/workspace-roots.js";

function makeDir(): string {
  const dir = join(
    tmpdir(),
    `praana-lsp-roots-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function gitInit(dir: string): void {
  const r = spawnSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git init failed: ${r.stderr}`);
  }
}

describe("discoverWorkspaceMembers", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads npm/yarn workspaces from package.json array", () => {
    mkdirSync(join(dir, "packages", "core"), { recursive: true });
    mkdirSync(join(dir, "packages", "cli"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
    );
    writeFileSync(join(dir, "packages", "core", "package.json"), "{}");
    writeFileSync(join(dir, "packages", "cli", "package.json"), "{}");

    const members = discoverWorkspaceMembers(dir).sort();
    expect(members).toEqual([
      join(dir, "packages", "cli"),
      join(dir, "packages", "core"),
    ]);
  });

  it("reads workspaces.packages object form", () => {
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: { packages: ["apps/*"] } }),
    );
    writeFileSync(join(dir, "apps", "web", "package.json"), "{}");

    expect(discoverWorkspaceMembers(dir)).toEqual([join(dir, "apps", "web")]);
  });

  it("reads pnpm-workspace.yaml packages", () => {
    mkdirSync(join(dir, "packages", "a"), { recursive: true });
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    writeFileSync(join(dir, "packages", "a", "package.json"), "{}");

    expect(discoverWorkspaceMembers(dir)).toEqual([join(dir, "packages", "a")]);
  });

  it("keeps YAML 1.2 unquoted on/yes/no/off as package strings", () => {
    // YAML 1.1 coerced these to booleans; Bun.YAML (1.2) keeps them as strings.
    for (const name of ["on", "yes", "no", "off"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "package.json"), "{}");
    }
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - on\n  - yes\n  - no\n  - off\n",
    );

    expect(discoverWorkspaceMembers(dir).sort()).toEqual(
      ["no", "off", "on", "yes"].map((name) => join(dir, name)),
    );
  });

  it("ignores YAML 1.2 boolean package entries", () => {
    mkdirSync(join(dir, "packages", "keep"), { recursive: true });
    writeFileSync(join(dir, "packages", "keep", "package.json"), "{}");
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n  - true\n  - false\n",
    );

    expect(discoverWorkspaceMembers(dir)).toEqual([
      join(dir, "packages", "keep"),
    ]);
  });

  it("skips invalid pnpm-workspace.yaml including embedded NUL", () => {
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n\0truncated",
    );
    mkdirSync(join(dir, "packages", "a"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "package.json"), "{}");

    expect(discoverWorkspaceMembers(dir)).toEqual([]);
  });

  it("honors ! excludes", () => {
    mkdirSync(join(dir, "packages", "keep"), { recursive: true });
    mkdirSync(join(dir, "packages", "skip"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*", "!packages/skip"] }),
    );
    writeFileSync(join(dir, "packages", "keep", "package.json"), "{}");
    writeFileSync(join(dir, "packages", "skip", "package.json"), "{}");

    expect(discoverWorkspaceMembers(dir)).toEqual([join(dir, "packages", "keep")]);
  });

  it("expands ** recursively", () => {
    mkdirSync(join(dir, "packages", "deep", "nested"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/**"] }),
    );
    writeFileSync(join(dir, "packages", "deep", "nested", "package.json"), "{}");

    expect(discoverWorkspaceMembers(dir)).toEqual([
      join(dir, "packages", "deep", "nested"),
    ]);
  });

  it("skips directories without package.json", () => {
    mkdirSync(join(dir, "packages", "empty"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );

    expect(discoverWorkspaceMembers(dir)).toEqual([]);
  });
});

describe("resolveLspRoot", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns sessionRoot for a file with no workspace members", () => {
    const file = join(dir, "src", "a.ts");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(file, "export {};\n");
    expect(resolveLspRoot(file, dir)).toBe(dir);
  });

  it("picks the longest matching workspace member", () => {
    mkdirSync(join(dir, "packages", "core", "src"), { recursive: true });
    mkdirSync(join(dir, "packages", "cli"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(dir, "packages", "core", "package.json"), "{}");
    writeFileSync(join(dir, "packages", "cli", "package.json"), "{}");
    const file = join(dir, "packages", "core", "src", "a.ts");
    writeFileSync(file, "export {};\n");

    expect(resolveLspRoot(file, dir)).toBe(join(dir, "packages", "core"));
  });

  it("uses a nested git root when the file lives in a nested repo", () => {
    const nested = join(dir, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    gitInit(nested);
    const file = join(nested, "src.ts");
    writeFileSync(file, "export {};\n");

    expect(resolveLspRoot(file, dir)).toBe(nested);
  });

  it("prefers a workspace member over the nested git root", () => {
    gitInit(dir);
    mkdirSync(join(dir, "packages", "core"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(dir, "packages", "core", "package.json"), "{}");
    const file = join(dir, "packages", "core", "index.ts");
    writeFileSync(file, "export {};\n");

    expect(resolveLspRoot(file, dir)).toBe(join(dir, "packages", "core"));
  });

  it("ignores paths outside the session root", () => {
    const outside = join(tmpdir(), `praana-outside-${Date.now()}`, "a.ts");
    mkdirSync(join(outside, ".."), { recursive: true });
    writeFileSync(outside, "export {};\n");
    mkdirSync(join(dir, "packages", "core"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(dir, "packages", "core", "package.json"), "{}");

    expect(resolveLspRoot(outside, dir)).toBe(dir);
    rmSync(join(outside, ".."), { recursive: true, force: true });
  });
});
