import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

describe("system frame local date", () => {
  it("uses the local calendar date in both compiler modes", () => {
    const script = `
      import { setSystemTime } from "bun:test";
      import { buildSystemFrame } from "./src/compiler.js";
      import { buildClassicSystemFrame } from "./src/compile-classic.js";
      setSystemTime(new Date("2026-11-17T20:30:00Z"));
      console.log(buildSystemFrame("/project", "session", []));
      console.log(buildClassicSystemFrame("/project", "session", []));
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: "Asia/Kolkata" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/Current date: 2026-11-18 \(Asia\/Kolkata\)/g)).toHaveLength(2);
  });
});
