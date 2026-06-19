import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { resolveDefaultMemoryDbPath } from "./app-identity.js";
import { createEmbedder, MemoryStore, resolveEmbeddingBackend } from "./memory/index.js";
import type { PraanaConfig } from "./types.js";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export async function runMemoryDedupe(
  cwd: string,
  config: PraanaConfig,
): Promise<{ clustersMerged: number; entriesRemoved: number }> {
  if (!config.memory?.enabled) {
    throw new Error("Memory is disabled in config. Enable [memory] enabled = true first.");
  }

  const configuredPath = config.memory.db_path;
  let dbPath: string;
  if (configuredPath) {
    dbPath = expandHome(configuredPath);
    if (!dbPath.startsWith("/")) dbPath = join(cwd, dbPath);
  } else {
    dbPath = resolveDefaultMemoryDbPath();
  }

  const embedder = await createEmbedder(config.memory);
  const store = new MemoryStore({
    dbPath,
    embedder,
    summarizer: null,
    embeddingBackend: resolveEmbeddingBackend(config.memory, embedder),
  });

  try {
    const before = store.getEntryCount();
    const result = await store.reconcileDuplicates();
    const after = store.getEntryCount();
    console.log(
      `Memory dedupe complete: ${result.clustersMerged} ${result.clustersMerged === 1 ? "cluster" : "clusters"} merged, ${result.entriesRemoved} ${result.entriesRemoved === 1 ? "entry" : "entries"} removed (${before} → ${after})`,
    );
    return result;
  } finally {
    store.close();
  }
}
