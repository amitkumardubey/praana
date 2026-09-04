import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { runUpgrade } from "../src/update/upgrade.js";

describe("runUpgrade", () => {
  it("refuses to overwrite a source checkout", async () => {
    const result = await runUpgrade({
      kind: "source",
      runInstaller: async () => {
        throw new Error("should not run");
      },
    });
    expect(result.ranInstaller).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.lines.join("\n")).toContain("git checkout");
  });

  it("uses dirname(execPath) as prefix for standalone", async () => {
    let prefix: string | undefined;
    const result = await runUpgrade({
      kind: "standalone",
      execPath: "/opt/praana/bin/praana",
      platform: "linux",
      runInstaller: async (args) => {
        prefix = args.prefix;
        return { ok: true, output: "Installed\n" };
      },
      whichPraana: () => "/opt/praana/bin/praana",
      versionOf: () => "PRAANA v0.16.0",
    });
    expect(prefix).toBe("/opt/praana/bin");
    expect(result.ranInstaller).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("v0.16.0");
  });

  it("installs bun/npm/brew into the default user prefix", async () => {
    const home = "/tmp/praana-home";
    for (const kind of ["bun_global", "npm_global", "brew", "unknown"] as const) {
      let prefix: string | undefined;
      const result = await runUpgrade({
        kind,
        platform: "linux",
        homedir: home,
        runInstaller: async (args) => {
          prefix = args.prefix;
          return { ok: true, output: "ok\n" };
        },
        whichPraana: () => join(home, ".local/bin/praana"),
        versionOf: () => "PRAANA v0.16.0",
      });
      expect(prefix).toBe(join(home, ".local/bin"));
      expect(result.ranInstaller).toBe(true);
      expect(result.exitCode).toBe(0);
    }
  });

  it("warns when PATH still resolves to a bun/npm copy", async () => {
    const result = await runUpgrade({
      kind: "bun_global",
      platform: "linux",
      homedir: "/home/amit",
      runInstaller: async () => ({ ok: true, output: "ok\n" }),
      whichPraana: () => "/home/amit/.bun/bin/praana",
      versionOf: () => "PRAANA v0.16.0",
    });
    expect(result.exitCode).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain(".local/bin");
    expect(text.toLowerCase()).toContain("bun remove");
  });

  it("does not spawn bun add -g", async () => {
    let command = "";
    await runUpgrade({
      kind: "bun_global",
      platform: "linux",
      homedir: "/tmp",
      runInstaller: async (args) => {
        command = args.command;
        return { ok: true, output: "ok\n" };
      },
      whichPraana: () => "/tmp/.local/bin/praana",
      versionOf: () => "PRAANA v0.16.0",
    });
    expect(command).toContain("install.sh");
    expect(command).not.toContain("bun add");
  });
});
