/**
 * Transcript store performance harness (Solid path).
 *
 * Run with:
 *   bun run scripts/benchmark-virtual-transcript.ts
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import { buildTranscriptIndex } from "../src/ui/tui/transcript/index.js";
import { createTranscriptStore } from "../src/ui/tui/transcript/store.js";
import { generateLargeTranscriptEvents } from "../tests/fixtures/large-transcript.js";

interface BenchmarkSample {
  name: string;
  ms: number;
  details?: Record<string, number | string>;
}

interface BenchmarkResult {
  metadata: {
    runtime: string;
    bunVersion: string;
    platform: string;
    arch: string;
    cpus: number;
    totalMemoryMb: number;
    timestamp: string;
  };
  fixture: {
    turns: number;
    totalEvents: number;
    totalEntries: number;
    totalGroups: number;
    approximateBodyBytes: number;
  };
  samples: BenchmarkSample[];
}

function measure<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { result, ms };
}

async function main() {
  const turns = 250;
  const thinkingChars = 5_000;
  const toolChars = 50_000;

  const events = generateLargeTranscriptEvents({ turns, thinkingChars, toolChars });
  const approximateBodyBytes = turns * (thinkingChars + toolChars) * 2;

  const build = measure(() => buildTranscriptIndex(events, { useUnicode: true }));
  const index = build.result;
  const totalEntries = index.groups.reduce(
    (sum, group) => sum + group.entries.length,
    0,
  );

  const mount = measure(() => {
    const store = createTranscriptStore();
    store.loadIndex(index);
    return store;
  });
  const store = mount.result;

  const tail = store.entries[store.entries.length - 1];
  const streamId =
    store.entries.find((e) => e.role === "assistant")?.id ??
    (tail && tail.role === "assistant" ? tail.id : null);

  const stream = measure(() => {
    if (streamId) store.mount.appendAssistantDelta(streamId, " extra word");
  });

  const clear = measure(() => {
    store.clear();
  });

  store.dispose();

  const result: BenchmarkResult = {
    metadata: {
      runtime: "Bun",
      bunVersion: process.versions.bun ?? "unknown",
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      timestamp: new Date().toISOString(),
    },
    fixture: {
      turns,
      totalEvents: events.length,
      totalEntries,
      totalGroups: index.groups.length,
      approximateBodyBytes,
    },
    samples: [
      { name: "build_index", ms: build.ms },
      { name: "resume_load_store", ms: mount.ms },
      { name: "tail_streaming_patch", ms: stream.ms },
      { name: "clear_store", ms: clear.ms },
    ],
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
