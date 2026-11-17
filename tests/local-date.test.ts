import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { daysSinceLocalDate, formatLocalDate } from "../src/local-date.js";

describe("local calendar date", () => {
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

  it.each([
    ["Asia/Kolkata", "2026-11-17T20:30:00Z", "2026-11-18", "2026-11-19"],
    ["America/Los_Angeles", "2026-11-17T02:30:00Z", "2026-11-16", "2026-11-17"],
  ])("stamps new and updated memories with the local date in %s", (tz, instant, createdDate, updatedDate) => {
    const script = `
      import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
      import { homedir } from "node:os";
      import { join } from "node:path";
      import { createFileMemoryStore } from "./src/file-memory/store.js";
      const cache = join(homedir(), ".cache");
      mkdirSync(cache, { recursive: true });
      const home = mkdtempSync(join(cache, "praana-memory-date-"));
      let clock = new Date(${JSON.stringify(instant)});
      const store = createFileMemoryStore({ home, cwd: home, findRoot: (cwd) => cwd, now: () => clock });
      const input = { scope: "global", type: "user", name: "coffee", description: "Prefers coffee", body: "Coffee preferred." };
      try {
        if (!(await store.write(input)).ok) throw new Error("create failed");
        const created = await store.read({ name: input.name });
        clock = new Date(clock.getTime() + 86400000);
        if (!(await store.write({ ...input, body: "Coffee every morning." })).ok) throw new Error("update failed");
        const updated = await store.read({ name: input.name });
        console.log(JSON.stringify([created.memory.updated, updated.memory.updated]));
      } finally { rmSync(home, { recursive: true, force: true }); }
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(), env: { ...process.env, TZ: tz }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([createdDate, updatedDate]);
  });
});

describe("daysSinceLocalDate", () => {
  it("counts whole local calendar days from the stamp to now", () => {
    const now = new Date(2026, 10, 18, 0, 30); // 00:30 local on 2026-11-18
    expect(daysSinceLocalDate("2026-11-18", now)).toBe(0);
    expect(daysSinceLocalDate("2026-11-17", now)).toBe(1);
    expect(daysSinceLocalDate("2026-08-20", now)).toBe(90);
  });

  it("does not count a stamp written minutes ago as a day old, whatever the UTC date", () => {
    const now = new Date(2026, 10, 17, 20, 0); // evening local
    expect(daysSinceLocalDate(formatLocalDate(now), now)).toBe(0);
  });
});
