import { describe, it, expect } from "vitest";
import {
  CODING_SYNONYMS,
  isTestCommand,
  isDiffContent,
  isTestOutputContent,
  isBuildOutputContent,
  isCodeContent,
  hasTestMarkers,
  inferContentTypeFromTool,
  extractCommitMessage,
  extractFailureCount,
  createDefaultDistillerRegistry,
} from "../src/domain/coding-domain.js";

// ---------------------------------------------------------------------------
// CODING_SYNONYMS
// ---------------------------------------------------------------------------

describe("CODING_SYNONYMS", () => {
  it("contains expected keys", () => {
    const keys = Object.keys(CODING_SYNONYMS);
    expect(keys).toContain("deploy");
    expect(keys).toContain("database");
    expect(keys).toContain("container");
    expect(keys).toContain("aws");
    expect(keys).toContain("test");
    expect(keys).toContain("build");
    expect(keys).toContain("error");
    expect(keys).toContain("fix");
    expect(keys).toContain("code");
    expect(keys).toContain("review");
    expect(keys).toContain("config");
    expect(keys).toContain("monitor");
    expect(keys).toContain("auth");
    expect(keys).toContain("api");
  });

  it("database includes postgres", () => {
    expect(CODING_SYNONYMS.database).toContain("postgres");
  });
});

// ---------------------------------------------------------------------------
// isTestCommand
// ---------------------------------------------------------------------------

describe("isTestCommand", () => {
  it.each([
    "npm test",
    "pnpm test",
    "vitest run",
    "pytest",
    "cargo test",
    "yarn test",
    "go test",
  ])("recognises %s", (cmd) => {
    expect(isTestCommand(cmd)).toBe(true);
  });

  it.each(["npm run build", "git status", "ls -la"])(
    "rejects %s",
    (cmd) => {
      expect(isTestCommand(cmd)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Content-type predicates
// ---------------------------------------------------------------------------

describe("isDiffContent", () => {
  it("detects git diff header", () => {
    expect(isDiffContent("diff --git a/foo.ts b/foo.ts\nindex abc..def 100644")).toBe(true);
  });

  it("detects hunk header", () => {
    expect(isDiffContent("@@ -1,3 +1,4 @@\n import foo")).toBe(true);
  });

  it("rejects plain prose", () => {
    expect(isDiffContent("Just some regular text.")).toBe(false);
  });
});

describe("isTestOutputContent", () => {
  it("detects test pass/fail with test word", () => {
    expect(isTestOutputContent("FAIL tests/a.test.ts ✓ 2 passed")).toBe(true);
  });

  it("rejects plain prose", () => {
    expect(isTestOutputContent("Nothing test-related here.")).toBe(false);
  });
});

describe("isBuildOutputContent", () => {
  it("detects TypeScript error", () => {
    expect(isBuildOutputContent("error TS2304: Cannot find name 'x'")).toBe(true);
  });

  it("detects generic build error", () => {
    expect(isBuildOutputContent("error: src/foo.ts:42: expected ';'")).toBe(true);
  });

  it("rejects plain prose", () => {
    expect(isBuildOutputContent("Build completed successfully.")).toBe(false);
  });
});

describe("isCodeContent", () => {
  it("detects import statement", () => {
    expect(isCodeContent("import { foo } from 'bar'")).toBe(true);
  });

  it("detects code fence", () => {
    expect(isCodeContent("```\nconst x = 1;\n```")).toBe(true);
  });

  it("detects Python def", () => {
    expect(isCodeContent("def foo():\n    pass")).toBe(true);
  });

  it("rejects plain prose", () => {
    expect(isCodeContent("Just some regular text.")).toBe(false);
  });
});

describe("hasTestMarkers", () => {
  it("detects FAIL", () => {
    expect(hasTestMarkers("FAIL some test")).toBe(true);
  });

  it("detects test count", () => {
    expect(hasTestMarkers("3 tests passed")).toBe(true);
  });

  it("rejects plain ok", () => {
    expect(hasTestMarkers("ok")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// inferContentTypeFromTool
// ---------------------------------------------------------------------------

describe("inferContentTypeFromTool", () => {
  it("rg → search_results", () => {
    expect(inferContentTypeFromTool("shell", "rg foo")).toBe("search_results");
  });

  it("git diff → diff", () => {
    expect(inferContentTypeFromTool("shell", "git diff")).toBe("diff");
  });

  it("npm test → test_output", () => {
    expect(inferContentTypeFromTool("shell", "npm test")).toBe("test_output");
  });

  it("tsc → build_output", () => {
    expect(inferContentTypeFromTool("shell", "tsc")).toBe("build_output");
  });

  it("ls → null", () => {
    expect(inferContentTypeFromTool("shell", "ls")).toBe(null);
  });

  it("no command → null", () => {
    expect(inferContentTypeFromTool("shell", undefined)).toBe(null);
  });

  it("whitespace-only command → null", () => {
    expect(inferContentTypeFromTool("shell", "   ")).toBe(null);
  });

  it("non-shell tool → null", () => {
    expect(inferContentTypeFromTool("read_file", "rg foo")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// extractCommitMessage
// ---------------------------------------------------------------------------

describe("extractCommitMessage", () => {
  it("parses JSON stdout", () => {
    const input = JSON.stringify({ stdout: "main: fix the bug\n" });
    expect(extractCommitMessage(input)).toBe("main: fix the bug");
  });

  it("parses JSON output field", () => {
    const input = JSON.stringify({ output: "fallback msg\n" });
    expect(extractCommitMessage(input)).toBe("fallback msg");
  });

  it("falls back to first line for non-JSON", () => {
    expect(extractCommitMessage("first line\nsecond line")).toBe("first line");
  });

  it("returns 'changes' for empty input", () => {
    expect(extractCommitMessage("")).toBe("changes");
  });

  it("returns 'changes' for undefined", () => {
    expect(extractCommitMessage(undefined)).toBe("changes");
  });
});

// ---------------------------------------------------------------------------
// extractFailureCount
// ---------------------------------------------------------------------------

describe("extractFailureCount", () => {
  it("extracts numeric count", () => {
    expect(extractFailureCount("3 failing")).toBe("3 failures");
  });

  it("detects generic FAIL", () => {
    expect(extractFailureCount("FAIL")).toBe("failures detected");
  });

  it("detects lowercase failure word", () => {
    expect(extractFailureCount("the configuration is a failure")).toBe("failures detected");
  });

  it("returns 'unknown count' for empty input", () => {
    expect(extractFailureCount("")).toBe("unknown count");
  });

  it("returns 'unknown count' for undefined", () => {
    expect(extractFailureCount(undefined)).toBe("unknown count");
  });
});

// ---------------------------------------------------------------------------
// createDefaultDistillerRegistry
// ---------------------------------------------------------------------------

describe("createDefaultDistillerRegistry", () => {
  it("returns a registry with distillers", () => {
    const registry = createDefaultDistillerRegistry();
    const sampleDiff = "diff --git a/foo.ts b/foo.ts\nindex abc..def 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n+import foo";
    const result = registry.distillSync(sampleDiff, "diff", "full");
    expect(result).toBeDefined();
    expect(result.distillerName).toBe("git-diff");
  });
});
