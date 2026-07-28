/**
 * Virtual transcript performance harness for issue #269.
 *
 * Run with:
 *   bun run scripts/benchmark-virtual-transcript.ts
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import { buildTranscriptIndex } from "../src/ui/tui/transcript/index.js";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
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
    mountedGroups: number;
    totalGroups: number;
    approximateBodyBytes: number;
  };
  samples: BenchmarkSample[];
}

function fakeTui() {
  return { requestRender: () => {} } as never;
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
  const approximateBodyBytes =
    turns * (thinkingChars + toolChars) * 2; // rough UTF-8 byte count

  const build = measure(() => buildTranscriptIndex(events, { useUnicode: true }));
  const index = build.result;
  const totalEntries = index.groups.reduce(
    (sum, group) => sum + group.entries.length,
    0,
  );

  const mount = measure(() => {
    const container = new TranscriptContainer(fakeTui(), {
      markdownRendering: false,
      syntaxTheme: "nord",
      backgroundZones: false,
      useUnicode: true,
    });
    container.loadIndex(index);
    return container;
  });
  const container = mount.result;

  const render = measure(() => container.render(120));

  // Simulate streaming an assistant delta at the tail.
  const tailGroup = container.getTotalGroups();
  const stream = measure(() =>
    container.appendAssistantDelta(`assistant-${tailGroup}`, " extra word"),
  );

  // Page to the oldest group and measure prepend cost.
  const prependSamples: number[] = [];
  while (container.getMountedGroupRange().start > 0) {
    const s = measure(() => container.onScrollUp());
    prependSamples.push(s.ms);
  }
  const prependP95 = prependSamples.sort((a, b) => a - b)[
    Math.floor(prependSamples.length * 0.95)
  ] ?? 0;

  // Focus and expand the largest (newest) tool row.
  container.setFocused(true);
  const expandStart = performance.now();
  container.handleInput("\r"); // expand selected tail entry
  // Allow the async resolver to complete.
  while (container.pendingExpansions.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const expandMs = performance.now() - expandStart;

  const collapse = measure(() => {
    container.handleInput("\r"); // collapse
  });

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
      mountedGroups: container.getMountedGroupRange().end - container.getMountedGroupRange().start,
      totalGroups: container.getTotalGroups(),
      approximateBodyBytes,
    },
    samples: [
      { name: "build_index", ms: build.ms },
      { name: "resume_mount", ms: mount.ms },
      { name: "render_mounted_range", ms: render.ms },
      { name: "tail_streaming_patch", ms: stream.ms },
      {
        name: "upward_page_prepend_p95",
        ms: prependP95,
        details: { prependCalls: prependSamples.length },
      },
      { name: "expand_large_tool_body", ms: expandMs },
      { name: "collapse_large_tool_body", ms: collapse.ms },
    ],
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
