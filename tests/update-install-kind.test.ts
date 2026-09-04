import { describe, it, expect } from "bun:test";
import { classifyInstallKind } from "../src/update/install-kind.js";

describe("classifyInstallKind", () => {
  it("detects a source checkout via src/main.ts", () => {
    expect(
      classifyInstallKind({
        execPath: "/home/amit/.bun/bin/bun",
        argv: ["/home/amit/.bun/bin/bun", "/home/amit/projects/personal/praana/src/main.ts"],
        sidecarExists: false,
      }),
    ).toBe("source");
  });

  it("detects a source checkout via repo bin/praana.js", () => {
    expect(
      classifyInstallKind({
        execPath: "/usr/bin/bun",
        argv: ["/usr/bin/bun", "/home/amit/projects/personal/praana/bin/praana.js"],
        sidecarExists: false,
      }),
    ).toBe("source");
  });

  it("detects standalone when execPath is praana with a sidecar", () => {
    expect(
      classifyInstallKind({
        execPath: "/home/amit/.local/bin/praana",
        argv: ["/home/amit/.local/bin/praana"],
        sidecarExists: true,
      }),
    ).toBe("standalone");
  });

  it("detects brew before sidecar", () => {
    expect(
      classifyInstallKind({
        execPath: "/opt/homebrew/Cellar/praana/0.15.1/bin/praana",
        argv: ["/opt/homebrew/Cellar/praana/0.15.1/bin/praana"],
        sidecarExists: true,
      }),
    ).toBe("brew");
  });

  it("detects bun global installs", () => {
    expect(
      classifyInstallKind({
        execPath: "/root/.bun/bin/bun",
        argv: [
          "/root/.bun/bin/bun",
          "/root/.bun/install/global/node_modules/praana/bin/praana.js",
        ],
        sidecarExists: false,
      }),
    ).toBe("bun_global");
  });

  it("detects npm global installs", () => {
    expect(
      classifyInstallKind({
        execPath: "/usr/bin/node",
        argv: ["/usr/bin/node", "/usr/lib/node_modules/praana/bin/praana.js"],
        sidecarExists: false,
      }),
    ).toBe("npm_global");
  });

  it("falls back to unknown", () => {
    expect(
      classifyInstallKind({
        execPath: "/usr/bin/python",
        argv: ["/usr/bin/python"],
        sidecarExists: false,
      }),
    ).toBe("unknown");
  });
});
