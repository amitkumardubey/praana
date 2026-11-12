import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/event-log.js";

const event = (id: string) => ({ event_id: id, session_id: "s", timestamp: 1, kind: "user_message" as const, actor: "user" as const, payload: { text: id } });
const line = (id: string) => JSON.stringify(event(id));
const append = (log: EventLog, id: string) => log.append(event(id));

describe("event log corruption and partial writes", () => {
  let dir: string;
  let log: EventLog;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eventlog-corrupt-")); });
  afterEach(() => { log?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("keeps valid events before a torn tail and separates the next append", () => {
    log = new EventLog("s", dir);
    writeFileSync(log.getLogPath(), `${line("a")}\n${line("b")}\n{"event_id":`);
    expect(log.readAll().map(e => e.event_id)).toEqual(["a", "b"]);
    expect(log.corruptLineCount).toBe(1);
    append(log, "c");
    expect(log.readAll().map(e => e.event_id)).toEqual(["a", "b", "c"]);
    const lines = readFileSync(log.getLogPath(), "utf8").trimEnd().split("\n");
    expect(lines[2]).toBe('{"event_id":');
    expect(JSON.parse(lines[3]).event_id).toBe("c");
  });

  it("skips malformed and event-shaped invalid lines in the middle", () => {
    log = new EventLog("s", dir);
    writeFileSync(log.getLogPath(), `${line("a")}\nnope\n{}\n${line("b")}\n`);
    expect(log.readAll().map(e => e.event_id)).toEqual(["a", "b"]);
    expect(log.corruptLineCount).toBe(2);
    expect(log.lastCorruptLine?.lineNumber).toBe(3);
  });

  it("counts every garbage line without throwing", () => {
    log = new EventLog("s", dir);
    writeFileSync(log.getLogPath(), "garbage\nnull\n[1]\n");
    expect(log.readAll()).toEqual([]);
    expect(log.corruptLineCount).toBe(3);
  });

  it("reports corruption only once per instance even after reload", () => {
    const warnings: unknown[] = [];
    log = new EventLog("s", dir, { onCorruptLine: info => warnings.push(info) });
    writeFileSync(log.getLogPath(), "bad\n");
    log.readAll();
    writeFileSync(log.getLogPath(), "bad\nworse\n");
    log.readAll();
    expect(warnings).toHaveLength(1);
    expect(log.corruptLineCount).toBe(2);
  });

  it("completes a short byte write before syncing", () => {
    let calls = 0;
    log = new EventLog("s", dir, { write: (fd, buffer, offset, length) => {
      calls++;
      return writeSync(fd, buffer, offset, calls === 1 ? Math.floor(length / 2) : length);
    } });
    append(log, "é");
    expect(calls).toBeGreaterThan(1);
    const lines = readFileSync(log.getLogPath(), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event_id).toBe("é");
  });

  it("reloads after fsync fails following a successful write", () => {
    log = new EventLog("s", dir, { fsync: () => { throw new Error("fsync failed"); } });
    expect(() => append(log, "a")).toThrow("fsync failed");
    expect(log.readAll().map(e => e.event_id)).toEqual(["a"]);
    expect(log.readAll()).toEqual([JSON.parse(readFileSync(log.getLogPath(), "utf8"))]);
  });

  it("recovers after a partial write throws and separates the next append", () => {
    let calls = 0;
    log = new EventLog("s", dir, { write: (fd, buffer, offset, length) => {
      calls++;
      if (calls === 1) return writeSync(fd, buffer, offset, 10);
      if (calls === 2) throw new Error("partial write failed");
      return writeSync(fd, buffer, offset, length);
    } });
    expect(() => append(log, "a")).toThrow("partial write failed");
    expect(log.readAll()).toEqual([]);
    append(log, "b");
    expect(log.readAll().map(e => e.event_id)).toEqual(["b"]);
    expect(log.corruptLineCount).toBe(1);
  });

  it("reloads after a write fails before writing bytes", () => {
    log = new EventLog("s", dir, { write: () => { throw new Error("write failed"); }, fsync: fsyncSync });
    expect(() => append(log, "a")).toThrow("write failed");
    expect(log.readAll()).toEqual([]);
    expect(readFileSync(log.getLogPath(), "utf8")).toBe("");
  });
});
