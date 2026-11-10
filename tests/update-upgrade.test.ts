import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { runUpgrade } from "../src/update/upgrade.js";

describe("runUpgrade", () => {
  it("reports when neither source nor cache is available", async () => {
    const result = await runUpgrade({ kind: "standalone", checkOffline: true, runInstaller: async () => { throw new Error("must not run"); } });
    expect(result.lines.join("\n")).toContain("Could not check for a newer version");
    expect(result.ranInstaller).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("refuses to claim up to date when the check was offline", async () => {
    const result = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.1", latestVersion: "0.18.1", checkOffline: true,
      runInstaller: async () => { throw new Error("must not run"); } });
    expect(result.lines.join("\n")).toContain("Could not check for a newer version; using the last known: v0.18.1");
    expect(result.lines.join("\n")).toContain("Could not verify that you are up to date. Re-run later, or use --force to reinstall.");
    expect(result.exitCode).toBe(1);
    expect(result.ranInstaller).toBe(false);
  });

  it("proceeds with the installer when the cached latest is newer", async () => {
    const result = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.0", latestVersion: "0.18.1", checkOffline: true,
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => "PRAANA v0.18.1" });
    expect(result.lines.join("\n")).toContain("Could not check for a newer version; using the last known: v0.18.1");
    expect(result.ranInstaller).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("notes the failed check when --force is given offline without a cache", async () => {
    const result = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.0", checkOffline: true, force: true,
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => "PRAANA v0.18.0" });
    expect(result.lines.join("\n")).toContain("Could not check for a newer version; continuing because --force was given.");
    expect(result.ranInstaller).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("keeps the up-to-date message for a matching fresh version", async () => {
    const result = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.0", latestVersion: "0.18.0" });
    expect(result.lines).toEqual(["Already up to date (v0.18.0)."]);
    expect(result.ranInstaller).toBe(false);
  });

  it("suggests clearing the shell command cache only after success", async () => {
    const hint = "If your shell still shows the old version, run `hash -r` (bash) or `rehash` (zsh).";
    const success = await runUpgrade({ kind: "standalone", platform: "linux", runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => null });
    expect(success.lines).toContain(hint);
    const failure = await runUpgrade({ kind: "standalone", platform: "linux", runInstaller: async () => ({ ok: false, output: "failed" }) });
    expect(failure.lines).not.toContain(hint);
  });

  it("omits the shell-cache hint on Windows", async () => {
    const result = await runUpgrade({ kind: "standalone", platform: "win32",
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => "PRAANA v0.18.1" });
    expect(result.lines.join("\n")).not.toContain("hash -r");
    expect(result.lines.join("\n")).not.toContain("rehash");
  });

  it("warns when the installed version differs from the target", async () => {
    const result = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.0", latestVersion: "0.18.1",
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => "PRAANA v0.18.0" });
    expect(result.exitCode).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("Installed version differs from the expected v0.18.1; the GitHub release may not be published yet. Re-run later.");
    expect(text.indexOf("Installed version differs")).toBeLessThan(text.indexOf("Restart praana"));
  });

  it("does not warn when the installed version matches the target", async () => {
    const result = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.0", latestVersion: "0.18.1",
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => "PRAANA v0.18.1" });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).not.toContain("Installed version differs");
  });

  it("does not warn when no version is reported", async () => {
    const result = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.0", latestVersion: "0.18.1",
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => null });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).not.toContain("Installed version differs");
  });

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
    // The warning prints the prefix joined with the host separator.
    expect(text).toContain(join(".local", "bin"));
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
