import { describe, expect, it } from "bun:test";
import { suggestPaths } from "../src/validate/fuzzy-path.js";

describe("suggestPaths", () => {
  const root = "/proj";
  const candidates = [
    "/proj/src/hooks/index.ts",
    "/proj/src/hooks/types.ts",
    "/proj/src/session.ts",
    "/proj/node_modules/foo/index.ts",
  ];

  it("ranks basename equality first", () => {
    expect(suggestPaths("types.ts", candidates, 5, root)[0]).toBe(
      "/proj/src/hooks/types.ts",
    );
  });

  it("matches a relative suffix", () => {
    expect(suggestPaths("hooks/index.ts", candidates, 5, root)).toContain(
      "/proj/src/hooks/index.ts",
    );
  });

  it("suggests a close basename typo", () => {
    expect(suggestPaths("sesion.ts", candidates, 5, root)).toContain(
      "/proj/src/session.ts",
    );
  });

  it("skips node_modules and caps at 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => `/proj/a${i}.ts`);
    const out = suggestPaths("a0.ts", [...many, "/proj/node_modules/x.ts"], 5, root);
    expect(out).toHaveLength(5);
    expect(out.every((p) => !p.includes("node_modules"))).toBe(true);
  });
});
