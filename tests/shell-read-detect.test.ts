import { describe, it, expect } from "bun:test";
import { detectShellReads } from "../src/tools/shell-read-detect.js";

describe("detectShellReads", () => {
  it("detects simple cat/head/tail/less/more/bat", () => {
    expect(detectShellReads("cat src/a.ts")).toEqual({
      kind: "cat",
      paths: ["src/a.ts"],
    });
    expect(detectShellReads("head -n 20 foo.ts")?.paths).toEqual(["foo.ts"]);
    expect(detectShellReads("tail -n 5 bar.ts")?.paths).toEqual(["bar.ts"]);
    expect(detectShellReads("less README.md")?.kind).toBe("less");
    expect(detectShellReads("more README.md")?.kind).toBe("more");
    expect(detectShellReads("bat src/x.ts")?.paths).toEqual(["src/x.ts"]);
  });

  it("detects multi-file cat", () => {
    expect(detectShellReads("cat a.ts b.ts")?.paths).toEqual(["a.ts", "b.ts"]);
  });

  it("detects sed -n print ranges only", () => {
    expect(detectShellReads("sed -n '10,40p' src/a.ts")?.paths).toEqual(["src/a.ts"]);
    expect(detectShellReads("sed -n 10,40p src/a.ts")?.paths).toEqual(["src/a.ts"]);
    expect(detectShellReads("sed -i 's/a/b/' src/a.ts")).toBeNull();
    expect(detectShellReads("sed 's/a/b/' src/a.ts")).toBeNull();
  });

  it("detects rg/grep with a trailing path", () => {
    expect(detectShellReads("rg TODO src/")?.paths).toEqual(["src/"]);
    expect(detectShellReads("grep -n foo bar.ts")?.paths).toEqual(["bar.ts"]);
  });

  it("returns null for pipes, compounds, non-reads, empty", () => {
    expect(detectShellReads("cat a.ts | head")).toBeNull();
    expect(detectShellReads("cat a.ts && echo x")).toBeNull();
    expect(detectShellReads("ls -la")).toBeNull();
    expect(detectShellReads("npm test")).toBeNull();
    expect(detectShellReads("")).toBeNull();
  });

  it("skips flags and treats -- as end of flags", () => {
    expect(detectShellReads("cat -n -- src/a.ts")?.paths).toEqual(["src/a.ts"]);
    expect(detectShellReads("head -n 10 -- foo.ts")?.paths).toEqual(["foo.ts"]);
  });
});
