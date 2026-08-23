import { describe, it, expect } from "bun:test";
import {
  pathToConstraint,
  fileTypeToConstraint,
  buildFffQuery,
} from "../src/fff.js";

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

describe("buildFffQuery", () => {
  it("prepends constraints before the pattern", () => {
    expect(buildFffQuery("foo", ["*.ts", "src/"])).toBe("*.ts src/ foo");
  });

  it("returns pattern unchanged with no constraints", () => {
    expect(buildFffQuery("foo", [])).toBe("foo");
    expect(buildFffQuery("foo", ["", null as unknown as string])).toBe("foo");
  });
});
