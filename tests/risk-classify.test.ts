import { describe, expect, it } from "bun:test";
import { classifyRisk } from "../src/risk/classify.js";

const cwd = "/proj";

describe("classifyRisk", () => {
  it("classifies rm including sudo and env prefixes", () => {
    expect(classifyRisk("shell", { command: "rm -rf /tmp/x" }, cwd)?.class).toBe("rm");
    expect(classifyRisk("shell", { command: "sudo rm -rf /tmp/x" }, cwd)?.class).toBe("rm");
    expect(classifyRisk("shell", { command: "FOO=1 rm foo" }, cwd)?.class).toBe("rm");
  });

  it("classifies git reset, force-push, and clean -f", () => {
    expect(classifyRisk("shell", { command: "git reset --hard HEAD" }, cwd)?.class).toBe(
      "git_reset",
    );
    expect(classifyRisk("shell", { command: "git push --force" }, cwd)?.class).toBe(
      "git_force_push",
    );
    expect(classifyRisk("shell", { command: "git push --force-with-lease" }, cwd)?.class).toBe(
      "git_force_push",
    );
    expect(classifyRisk("shell", { command: "git push -uf origin main" }, cwd)?.class).toBe(
      "git_force_push",
    );
    expect(classifyRisk("shell", { command: "git clean -fdx" }, cwd)?.class).toBe("git_clean");
  });

  it("leaves plain git push and git clean -n free", () => {
    expect(classifyRisk("shell", { command: "git push origin main" }, cwd)).toBeNull();
    expect(classifyRisk("shell", { command: "git clean -n" }, cwd)).toBeNull();
  });

  it("classifies gh close/merge and package install", () => {
    expect(classifyRisk("shell", { command: "gh issue close 1" }, cwd)?.class).toBe(
      "gh_issue_close",
    );
    expect(classifyRisk("shell", { command: "gh pr merge 2" }, cwd)?.class).toBe("gh_pr_merge");
    expect(classifyRisk("shell", { command: "npm install lodash" }, cwd)?.class).toBe(
      "package_install",
    );
    expect(classifyRisk("shell", { command: "pnpm add foo" }, cwd)?.class).toBe(
      "package_install",
    );
    expect(classifyRisk("shell", { command: "bun i bar" }, cwd)?.class).toBe("package_install");
  });

  it("leaves npm ci and npm run install free", () => {
    expect(classifyRisk("shell", { command: "npm ci" }, cwd)).toBeNull();
    expect(classifyRisk("shell", { command: "npm run install" }, cwd)).toBeNull();
  });

  it("flags write_file / batch path outside cwd", () => {
    expect(classifyRisk("write_file", { path: "../x.ts" }, cwd)?.class).toBe(
      "write_outside_cwd",
    );
    expect(
      classifyRisk("batch_write", { files: [{ path: "src/a.ts" }, { path: "/etc/passwd" }] }, cwd)
        ?.class,
    ).toBe("write_outside_cwd");
    expect(classifyRisk("write_file", { path: "src/a.ts" }, cwd)).toBeNull();
    expect(classifyRisk("edit_file", { path: "./src/a.ts" }, cwd)).toBeNull();
  });

  it("returns null for unknown tools and empty shell", () => {
    expect(classifyRisk("read_file", { path: "../x" }, cwd)).toBeNull();
    expect(classifyRisk("shell", { command: "" }, cwd)).toBeNull();
    expect(classifyRisk("git_commit", { message: "x" }, cwd)).toBeNull();
  });
});
