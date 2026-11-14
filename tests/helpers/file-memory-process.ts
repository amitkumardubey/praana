import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Scripts live beside their injected home, inside the test's scratch filesystem. */
export async function spawnMemoryChild(home: string, source: string) {
  const scripts = join(home, "scripts");
  await fs.mkdir(scripts, { recursive: true });
  const script = join(scripts, `${randomUUID()}.ts`);
  const storeUrl = pathToFileURL(resolve(import.meta.dir, "../../src/file-memory/store.ts")).href;
  const recorderUrl = pathToFileURL(resolve(import.meta.dir, "file-memory-fs.ts")).href;
  await fs.writeFile(script, `
    import { appendFileSync } from "node:fs";
    import { recordMemoryPaths } from ${JSON.stringify(recorderUrl)};
    import { createFileMemoryStore } from ${JSON.stringify(storeUrl)};
    const home = process.env.HOME;
    if (home !== process.argv[2] || process.cwd() !== home) throw new Error("Child home is not isolated");
    const { fs } = recordMemoryPaths(home, (record) => appendFileSync(${JSON.stringify(`${script}.paths.jsonl`)}, JSON.stringify(record) + "\\n"));
    const storeOptions = { home, cwd: home, fs, findRoot: (cwd) => cwd, now: () => new Date("2026-05-01T00:00:00Z") };
    ${source}
  `);
  return Bun.spawn([process.execPath, script, home], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, PRAANA_HOME: join(home, ".praana") },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    timeout: 15000, killSignal: "SIGKILL",
  });
}

export async function spawnBarrierMemoryChild(home: string, source: string) {
  return spawnMemoryChild(home, `
    console.log("READY:awaiting-start");
    if ((await Bun.stdin.text()).trim() !== "START") throw new Error("Invalid start signal");
    ${source}
  `);
}

export async function readRemainingText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

/** Consume only the handshake; the child must wait before printing further data. */
export async function waitForLine(stream: ReadableStream<Uint8Array>, timeoutMs = 10000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const line = async () => {
      let text = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Child exited before handshake: ${text}`);
        text += decoder.decode(chunk.value, { stream: true });
        const newline = text.indexOf("\n");
        if (newline !== -1) return text.slice(0, newline);
      }
    };
    return await Promise.race([line(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { void reader.cancel(); reject(new Error("Child handshake timed out")); }, timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}
