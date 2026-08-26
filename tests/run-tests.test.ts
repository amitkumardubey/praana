/**
 * Unit and integration tests for structured test runner tool (issue #321).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunAdapter } from "../src/tools/test-runner/adapters/bun.js";
import { NpmAdapter } from "../src/tools/test-runner/adapters/npm.js";
import { GoAdapter } from "../src/tools/test-runner/adapters/go.js";
import { CargoAdapter } from "../src/tools/test-runner/adapters/cargo.js";
import { PytestAdapter } from "../src/tools/test-runner/adapters/pytest.js";
import { GenericAdapter } from "../src/tools/test-runner/adapters/generic.js";
import { selectAdapter, executeTests } from "../src/tools/test-runner/runner.js";
import { createRunTestsTool } from "../src/tools/run-tests.js";
import { createAllTools, describeTools } from "../src/tools/index.js";
import { toolIcon, formatToolDisplay } from "../src/ui/tui/tool-icons.js";

describe("Test Runner Adapters", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `praana-test-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("BunAdapter", () => {
    const adapter = new BunAdapter();

    it("detects bun.lock or bun.lockb", () => {
      expect(adapter.detect(testDir)).toBe(false);
      writeFileSync(join(testDir, "bun.lockb"), "");
      expect(adapter.detect(testDir)).toBe(true);
    });

    it("builds bun test command", () => {
      expect(adapter.buildCommand({ cwd: testDir })).toEqual({
        command: "bun",
        args: ["test"],
      });
      expect(
        adapter.buildCommand({ cwd: testDir, files: ["tests/a.test.ts", "tests/b.test.ts"] }),
      ).toEqual({
        command: "bun",
        args: ["test", "tests/a.test.ts", "tests/b.test.ts"],
      });
      expect(
        adapter.buildCommand({ cwd: testDir, command: "bun test --watch" }),
      ).toEqual({
        command: "bun",
        args: ["test", "--watch"],
      });
    });

    it("parses bun test output with passes, fails, and skips", () => {
      const stdout = `
tests/git-tools.test.ts:
(pass) git_status returns clean working tree [0.15ms]
(skip) git_diff ignored test [0.01ms]
(fail) git_branches ahead/behind [1.20ms]
  Expected: 1
  Received: 0
  at tests/git-tools.test.ts:120:5

 1 pass
 1 fail
 1 skip
Ran 3 tests across 1 files. [12.00ms]
`;
      const result = adapter.parseOutput(stdout, "", 1);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.files).toContain("tests/git-tools.test.ts");
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.name).toBe("git_branches ahead/behind");
      expect(result.failures[0]?.file).toBe("tests/git-tools.test.ts");
      expect(result.failures[0]?.message).toContain("Expected: 1");
    });
  });

  describe("NpmAdapter", () => {
    const adapter = new NpmAdapter();

    it("detects package.json with scripts", () => {
      expect(adapter.detect(testDir)).toBe(false);
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({ scripts: { test: "jest" } }),
      );
      expect(adapter.detect(testDir)).toBe(true);
    });

    it("builds command respecting pnpm and yarn lockfiles", () => {
      writeFileSync(join(testDir, "package.json"), "{}");
      expect(adapter.buildCommand({ cwd: testDir })).toEqual({
        command: "npm",
        args: ["test"],
      });

      writeFileSync(join(testDir, "pnpm-lock.yaml"), "");
      expect(adapter.buildCommand({ cwd: testDir, files: ["foo.test.js"] })).toEqual({
        command: "pnpm",
        args: ["test", "--", "foo.test.js"],
      });

      rmSync(join(testDir, "pnpm-lock.yaml"));
      writeFileSync(join(testDir, "yarn.lock"), "");
      expect(adapter.buildCommand({ cwd: testDir, files: ["foo.test.js"] })).toEqual({
        command: "yarn",
        args: ["test", "foo.test.js"],
      });
    });

    it("parses Jest test output with failure excerpts", () => {
      const stdout = `
PASS src/foo.test.ts
FAIL src/bar.test.ts
  ● Bar suite › should do something
    AssertionError: expected true to be false
      at src/bar.test.ts:42:15

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 15 passed, 2 skipped, 18 total
Snapshots:   0 total
Time:        1.234 s
`;
      const result = adapter.parseOutput(stdout, "", 1);
      expect(result.passed).toBe(15);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.files).toContain("src/foo.test.ts");
      expect(result.files).toContain("src/bar.test.ts");
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.name).toContain("Bar suite › should do something");
      expect(result.failures[0]?.message).toContain("AssertionError");
    });
  });

  describe("GoAdapter", () => {
    const adapter = new GoAdapter();

    it("detects go.mod", () => {
      expect(adapter.detect(testDir)).toBe(false);
      writeFileSync(join(testDir, "go.mod"), "module example.com/foo\ngo 1.21\n");
      expect(adapter.detect(testDir)).toBe(true);
    });

    it("builds go test command", () => {
      expect(adapter.buildCommand({ cwd: testDir })).toEqual({
        command: "go",
        args: ["test", "-v", "./..."],
      });
      expect(adapter.buildCommand({ cwd: testDir, files: ["./pkg/..."] })).toEqual({
        command: "go",
        args: ["test", "-v", "./pkg/..."],
      });
    });

    it("parses go test output", () => {
      const stdout = `
=== RUN   TestSuccess
--- PASS: TestSuccess (0.01s)
=== RUN   TestSkip
--- SKIP: TestSkip (0.00s)
=== RUN   TestFail
    bar_test.go:30: assertion error: expected 5 got 3
--- FAIL: TestFail (0.02s)
FAIL
`;
      const result = adapter.parseOutput(stdout, "", 1);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.name).toBe("TestFail");
      expect(result.failures[0]?.message).toContain("assertion error");
    });
  });

  describe("CargoAdapter", () => {
    const adapter = new CargoAdapter();

    it("detects Cargo.toml", () => {
      expect(adapter.detect(testDir)).toBe(false);
      writeFileSync(join(testDir, "Cargo.toml"), "[package]\nname = \"foo\"\n");
      expect(adapter.detect(testDir)).toBe(true);
    });

    it("builds cargo test command", () => {
      expect(adapter.buildCommand({ cwd: testDir })).toEqual({
        command: "cargo",
        args: ["test"],
      });
      expect(adapter.buildCommand({ cwd: testDir, files: ["test_integ"] })).toEqual({
        command: "cargo",
        args: ["test", "--", "test_integ"],
      });
    });

    it("parses cargo test output", () => {
      const stdout = `
running 3 tests
test tests::test_ok ... ok
test tests::test_skip ... ignored
test tests::test_err ... FAILED

failures:

---- tests::test_err stdout ----
thread 'tests::test_err' panicked at src/lib.rs:10:9:
assertion failed: left == right

failures:
    tests::test_err

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;
      const result = adapter.parseOutput(stdout, "", 1);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.name).toBe("tests::test_err");
      expect(result.failures[0]?.message).toContain("assertion failed: left == right");
    });
  });

  describe("PytestAdapter", () => {
    const adapter = new PytestAdapter();

    it("detects pytest.ini or pyproject.toml", () => {
      expect(adapter.detect(testDir)).toBe(false);
      writeFileSync(join(testDir, "pyproject.toml"), "");
      expect(adapter.detect(testDir)).toBe(true);
    });

    it("builds pytest command", () => {
      expect(adapter.buildCommand({ cwd: testDir })).toEqual({
        command: "pytest",
        args: ["-v"],
      });
      expect(adapter.buildCommand({ cwd: testDir, files: ["tests/test_api.py"] })).toEqual({
        command: "pytest",
        args: ["-v", "tests/test_api.py"],
      });
    });

    it("parses pytest output", () => {
      const stdout = `
============================= test session starts ==============================
collected 3 items

tests/test_app.py::test_pass PASSED                                     [ 33%]
tests/test_app.py::test_skip SKIPPED                                    [ 66%]
tests/test_app.py::test_fail FAILED                                     [100%]

=================================== FAILURES ===================================
__________________________________ test_fail ___________________________________
tests/test_app.py:12: in test_fail
    assert 1 == 2
E   assert 1 == 2
=========================== short test summary info ============================
FAILED tests/test_app.py::test_fail - assert 1 == 2
=================== 1 failed, 1 passed, 1 skipped in 0.12s ====================
`;
      const result = adapter.parseOutput(stdout, "", 1);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.files).toContain("tests/test_app.py");
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.name).toBe("test_fail");
      expect(result.failures[0]?.message).toContain("assert 1 == 2");
    });
  });

  describe("GenericAdapter", () => {
    const adapter = new GenericAdapter();

    it("parses fallback output", () => {
      const stdout = "3 passing\n1 failing\nError: something broke";
      const result = adapter.parseOutput(stdout, "", 1);
      expect(result.passed).toBe(3);
      expect(result.failed).toBe(1);
      expect(result.failures).toHaveLength(1);
    });
  });
});

describe("selectAdapter", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `praana-select-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("selects adapter based on runner hint", () => {
    expect(selectAdapter(testDir, "go").name).toBe("go");
    expect(selectAdapter(testDir, "cargo").name).toBe("cargo");
    expect(selectAdapter(testDir, "pytest").name).toBe("pytest");
    expect(selectAdapter(testDir, "bun").name).toBe("bun");
  });

  it("selects adapter based on explicit command prefix", () => {
    expect(selectAdapter(testDir, undefined, "go test ./...").name).toBe("go");
    expect(selectAdapter(testDir, undefined, "cargo test --bin foo").name).toBe("cargo");
    expect(selectAdapter(testDir, undefined, "pytest -k unit").name).toBe("pytest");
    expect(selectAdapter(testDir, undefined, "bun test").name).toBe("bun");
  });

  it("falls back to generic adapter when nothing matches", () => {
    expect(selectAdapter(testDir).name).toBe("generic");
  });
});

describe("executeTests & run_tests Tool", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `praana-exec-tests-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("blocks execution if cwd is blocked by sandbox", async () => {
    const res = await executeTests({
      cwd: testDir,
      sandbox: {
        enabled: true,
        allowed_paths: ["/some/other/path"],
        auto_allow_cwd: false,
        allow_git_writes: false,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Blocked by sandbox");
      expect(res.code).toBe("sandbox_blocked");
    }
  });

  it("executes tests using command override and returns structured result", async () => {
    const res = await executeTests({
      cwd: testDir,
      command: "echo '(pass) sample test [0.1ms]' && echo '1 pass'",
      runner: "bun",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.runner).toBe("bun");
      expect(res.passed).toBe(1);
      expect(res.failed).toBe(0);
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("creates and registers run_tests in createAllTools and describeTools", () => {
    const tools = createRunTestsTool({ cwd: testDir });
    expect(tools.run_tests).toBeDefined();
    expect(tools.run_tests.description).toContain("structured pass/fail/skipped counts");

    const all = createAllTools({
      eventLog: {} as any,
      stateGraph: {} as any,
      memoryStore: null,
      memoryEnabled: false,
      incognito: false,
      contextEngine: null,
      cwd: testDir,
      skills: [],
      skillRuntime: null,
    });
    expect((all as any).run_tests).toBeDefined();

    const desc = describeTools();
    expect(desc.some((d) => d.startsWith("run_tests("))).toBe(true);
  });

  it("provides correct icons and display labels for run_tests", () => {
    expect(toolIcon("run_tests", true)).toBe("✓");
    expect(toolIcon("run_tests", false)).toBe("t·");

    const display = formatToolDisplay("run_tests", { command: "bun test tests/git.test.ts" });
    expect(display.label).toContain("bun test tests/git.test.ts");
    expect(display.pending).toBe("testing…");
  });
});
