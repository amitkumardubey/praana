import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { BUSY_TIMEOUT_MS } from "../src/sqlite.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "praana-busy-timeout-"));
}

describe("SQLite concurrency pragmas", () => {
  it("openContextEngineDb sets WAL and busy_timeout", () => {
    const dir = makeTempDir();
    const path = join(dir, "context.db");
    const db = openContextEngineDb(path);

    const busy = db.query("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(busy.timeout).toBe(BUSY_TIMEOUT_MS);

    const journal = db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journal.journal_mode.toLowerCase()).toBe("wal");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
