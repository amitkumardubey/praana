import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspClient, LspClientError } from "../src/lsp/client.js";
import { pathToFileUri } from "../src/lsp/types.js";

const fixture = join(import.meta.dirname, "fixtures", "fake-lsp-server.ts");
const fakeArgv = [process.execPath, "run", fixture];

describe("LspClient", () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `praana-lsp-client-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("initializes against the fake server and collects diagnostics", async () => {
    const client = await LspClient.start({
      command: fakeArgv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: 3000,
      env: {
        FAKE_LSP_DIAGNOSTICS: JSON.stringify([
          {
            message: "demo error",
            severity: 1,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
          },
        ]),
      },
    });

    try {
      const file = join(root, "a.ts");
      await client.didOpen(file, "typescript", "const x = 1;\n");
      await new Promise((r) => setTimeout(r, 50));
      const uri = pathToFileUri(file);
      const diags = client.getDiagnostics(uri);
      expect(diags.length).toBe(1);
      expect(diags[0]?.message).toBe("demo error");
      expect(diags[0]?.startLine).toBe(1);
      expect(diags[0]?.startCol).toBe(1);
      expect(client.supportsFormatting).toBe(true);
    } finally {
      await client.shutdown();
    }
  });

  it("returns formatting edits from the fake server", async () => {
    const client = await LspClient.start({
      command: fakeArgv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: 3000,
      env: {
        FAKE_LSP_EDITS: JSON.stringify([
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "// formatted\n",
          },
        ]),
      },
    });

    try {
      const file = join(root, "b.ts");
      await client.didOpen(file, "typescript", "x\n");
      const edits = await client.formatDocument(file);
      expect(edits).toHaveLength(1);
      expect(edits[0]?.newText).toBe("// formatted\n");
    } finally {
      await client.shutdown();
    }
  });

  it("times out slow requests", async () => {
    const client = await LspClient.start({
      command: fakeArgv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: 3000,
      env: {
        FAKE_LSP_DELAY_MS: "400",
      },
    });

    try {
      const file = join(root, "c.ts");
      await client.didOpen(file, "typescript", "x\n");
      await expect(
        client.formatDocument(file, { timeoutMs: 80 }),
      ).rejects.toMatchObject({
        code: "timeout",
      });
    } finally {
      await client.shutdown().catch(() => {});
    }
  }, 10_000);

  it("fails when the executable is missing", async () => {
    await expect(
      LspClient.start({
        command: ["/nonexistent/praana-lsp-server-xyz"],
        cwd: root,
        rootUri: pathToFileUri(root),
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(LspClientError);
  });

  it("reports hover/definition capabilities and returns hover", async () => {
    const client = await LspClient.start({
      command: fakeArgv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: 3000,
      env: {
        FAKE_LSP_HOVER: JSON.stringify({
          contents: { kind: "plaintext", value: "number" },
        }),
      },
    });
    try {
      expect(client.supportsHover).toBe(true);
      expect(client.supportsDefinition).toBe(true);
      const file = join(root, "h.ts");
      await client.didOpen(file, "typescript", "const n = 1;\n");
      const hover = await client.hover(file, { line: 0, character: 6 });
      expect(hover).toEqual({
        contents: { kind: "plaintext", value: "number" },
      });
    } finally {
      await client.shutdown();
    }
  });

  it("skips hover when server omits the capability", async () => {
    const client = await LspClient.start({
      command: fakeArgv,
      cwd: root,
      rootUri: pathToFileUri(root),
      timeoutMs: 3000,
      env: { FAKE_LSP_NO_HOVER: "1" },
    });
    try {
      expect(client.supportsHover).toBe(false);
    } finally {
      await client.shutdown();
    }
  });
});
