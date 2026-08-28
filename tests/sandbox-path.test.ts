import { describe, it, expect } from "bun:test";
import {
  pathToConstraint,
  fileTypeToConstraint,
  sandboxBlockReason,
} from "../src/sandbox-path.js";

describe("pathToConstraint", () => {
  it("returns null for empty or equal-to-base paths", () => {
    expect(pathToConstraint("/repo", "")).toBeNull();
    expect(pathToConstraint("/repo", "/repo")).toBeNull();
  });

  it("converts an absolute path under basePath to a base-relative dir constraint", () => {
    expect(pathToConstraint("/repo", "/repo/src")).toBe("src/");
    expect(pathToConstraint("/repo", "/repo/src/components")).toBe("src/components/");
  });

  it("converts a relative path to a dir constraint", () => {
    expect(pathToConstraint("/repo", "src")).toBe("src/");
    expect(pathToConstraint("/repo", "./src")).toBe("src/");
  });

  it("keeps file paths (with a dot) as-is", () => {
    expect(pathToConstraint("/repo", "src/main.ts")).toBe("src/main.ts");
  });

  it("returns null for paths outside basePath", () => {
    expect(pathToConstraint("/repo", "/outside")).toBeNull();
    expect(pathToConstraint("/repo", "../outside")).toBeNull();
  });
});

describe("fileTypeToConstraint", () => {
  it("maps known file types to extension globs", () => {
    expect(fileTypeToConstraint("ts")).toBe("*.ts");
    expect(fileTypeToConstraint("rust")).toBe("*.rs");
    expect(fileTypeToConstraint("py")).toBe("*.py");
    expect(fileTypeToConstraint("TS")).toBe("*.ts");
  });

  it("falls back to a generic extension glob for unknown types", () => {
    expect(fileTypeToConstraint("unknown")).toBe("*.unknown");
  });
});

describe("sandboxBlockReason", () => {
  it("returns null when sandbox is undefined", () => {
    expect(sandboxBlockReason("/any/path", undefined)).toBeNull();
  });

  it("returns null when sandbox is disabled", () => {
    expect(sandboxBlockReason("/any/path", { enabled: false, allowed_paths: [] })).toBeNull();
  });

  it("returns null when sandbox has no allowed_paths", () => {
    expect(sandboxBlockReason("/any/path", { enabled: true, allowed_paths: [] })).toBeNull();
  });

  it("blocks paths outside the allowlist", () => {
    const sb = { enabled: true, allowed_paths: ["/repo/src"] };
    expect(sandboxBlockReason("/repo/other", sb)).toMatch(/sandbox/i);
    expect(sandboxBlockReason("/repo/src", sb)).toBeNull();
  });
});
