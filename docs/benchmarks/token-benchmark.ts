#!/usr/bin/env node
/**
 * ARIA Token Benchmark
 *
 * Measures token savings from tiered memory across realistic state loads.
 * Generates synthetic state at different scales and compares:
 *   - All active (flat memory)
 *   - Tiered (active + soft + hard stubs)
 *
 * Usage:
 *   npx tsx eval/token-benchmark.ts [--objects N] [--ratio A]
 */

import { StateGraph } from "../src/state-graph.js";
import { compileWithMetrics, calculateTokenSavings } from "../src/compiler.js";
import { describeTools } from "../src/tools/index.js";

interface BenchmarkOptions {
  objectCount: number;
  activeRatio: number;
  softOfRemaining: number;
  avgTitleLen: number;
  avgDescLen: number;
  includeDigest: boolean;
  digestSize: number;
  recentEvents: number;
}

function generateSyntheticState(sg: StateGraph, opts: BenchmarkOptions) {
  const activeCount = Math.floor(opts.objectCount * opts.activeRatio);
  const remaining = opts.objectCount - activeCount;
  const softCount = Math.floor(remaining * opts.softOfRemaining);
  const hardCount = remaining - softCount;

  const loremWords = [
    "implement", "refactor", "test", "deploy", "monitor", "optimize",
    "cache", "query", "migration", "schema", "endpoint", "middleware",
    "async", "await", "promise", "callback", "handler", "router",
    "validation", "serialization", "deserialization", "authentication",
    "authorization", "rate", "limiting", "throttling",
  ];

  function randomText(targetLen: number): string {
    let s = "";
    while (s.length < targetLen) {
      const word = loremWords[Math.floor(Math.random() * loremWords.length)];
      s += (s ? " " : "") + word;
    }
    return s.slice(0, targetLen);
  }

  for (let i = 0; i < activeCount; i++) {
    const kind = ["task", "decision", "note", "constraint"][i % 4] as any;
    if (kind === "task") {
      sg.create("task", {
        title: randomText(opts.avgTitleLen),
        description: randomText(opts.avgDescLen),
        status: "doing",
      });
    } else if (kind === "decision") {
      sg.create("decision", {
        summary: randomText(opts.avgTitleLen),
        rationale: randomText(opts.avgDescLen * 2),
      });
    } else if (kind === "note") {
      sg.create("note", { text: randomText(opts.avgDescLen * 2) });
    } else {
      sg.create("constraint", { text: randomText(opts.avgDescLen) });
    }
  }

  for (let i = 0; i < softCount; i++) {
    const obj = sg.create("task", {
      title: randomText(opts.avgTitleLen),
      description: randomText(opts.avgDescLen),
      status: "done",
    });
    sg.setTier(obj.id, "soft");
  }

  for (let i = 0; i < hardCount; i++) {
    const obj = sg.create("note", { text: randomText(opts.avgDescLen * 2) });
    sg.setTier(obj.id, "hard");
  }

  return { activeCount, softCount, hardCount };
}

function generateFakeEvents(count: number) {
  const events: any[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      event_id: `evt-${i}`,
      session_id: "bench",
      timestamp: Date.now(),
      kind: "agent_message",
      actor: "agent",
      payload: { text: "Some agent response text that simulates a conversation turn.".repeat(3 + (i % 3)) },
    });
  }
  return events;
}

function runBenchmark(opts: BenchmarkOptions) {
  const sg = new StateGraph();
  const counts = generateSyntheticState(sg, opts);

  const digest = opts.includeDigest
    ? "## Previous Session Learnings\n\n".repeat(Math.ceil(opts.digestSize / 40))
    : null;

  const { prompt, metrics } = compileWithMetrics({
    stateGraph: sg,
    bodhaDigest: digest,
    recentEvents: generateFakeEvents(opts.recentEvents),
    userInput: "Implement a search feature",
    toolSchemas: describeTools(),
    cwd: "/home/user/project",
    sessionId: "bench-session",
    tokenBudget: 100_000,
    recentTurnsTokenBudget: 30_000,
  });

  const savings = calculateTokenSavings(sg);

  return {
    counts,
    metrics,
    savings,
    totalPromptLen: prompt.length,
  };
}

function main() {
  const args = process.argv.slice(2);
  let customObjects = 50;
  let customRatio = 0.2;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--objects" && args[i + 1]) {
      customObjects = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === "--ratio" && args[i + 1]) {
      customRatio = parseFloat(args[i + 1]);
      i++;
    }
  }

  const hasCustom = process.argv.includes("--objects") || process.argv.includes("--ratio");

  const scenarios: { name: string; opts: BenchmarkOptions }[] = [
    {
      name: "Small project, high activity",
      opts: {
        objectCount: 20,
        activeRatio: 0.5,
        softOfRemaining: 0.6,
        avgTitleLen: 40,
        avgDescLen: 120,
        includeDigest: true,
        digestSize: 500,
        recentEvents: 10,
      },
    },
    {
      name: "Medium project, scattered focus",
      opts: {
        objectCount: 60,
        activeRatio: 0.25,
        softOfRemaining: 0.5,
        avgTitleLen: 50,
        avgDescLen: 200,
        includeDigest: true,
        digestSize: 800,
        recentEvents: 12,
      },
    },
    {
      name: "Large project, low active surface",
      opts: {
        objectCount: 150,
        activeRatio: 0.15,
        softOfRemaining: 0.4,
        avgTitleLen: 50,
        avgDescLen: 250,
        includeDigest: true,
        digestSize: 1200,
        recentEvents: 15,
      },
    },
    {
      name: "Long session (lots of turns)",
      opts: {
        objectCount: 40,
        activeRatio: 0.3,
        softOfRemaining: 0.5,
        avgTitleLen: 45,
        avgDescLen: 180,
        includeDigest: true,
        digestSize: 600,
        recentEvents: 25,
      },
    },
  ];

  // Add custom scenario if user passed flags
  if (hasCustom) {
    scenarios.push({
      name: `Custom: ${customObjects} objects, ${Math.round(customRatio * 100)}% active`,
      opts: {
        objectCount: customObjects,
        activeRatio: customRatio,
        softOfRemaining: 0.5,
        avgTitleLen: 50,
        avgDescLen: 200,
        includeDigest: true,
        digestSize: 800,
        recentEvents: 12,
      },
    });
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ARIA Token Benchmark");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const { name, opts } of scenarios) {
    const result = runBenchmark(opts);
    const { counts, metrics, savings, totalPromptLen } = result;

    console.log(`\n${"─".repeat(65)}`);
    console.log(`  Scenario: ${name}`);
    console.log(`${"─".repeat(65)}`);
    console.log(`  State composition  : ${counts.activeCount} active, ${counts.softCount} soft, ${counts.hardCount} hard`);
    console.log(`  Prompt chars       : ${totalPromptLen.toLocaleString()}`);
    console.log(`  --- Token Breakdown ---`);
    console.log(`  System frame       : ${metrics.systemFrameTokens.toLocaleString().padStart(6)} tokens`);
    console.log(`  Cross-session      : ${metrics.crossSessionTokens.toLocaleString().padStart(6)} tokens`);
    console.log(`  Active state       : ${metrics.activeStateTokens.toLocaleString().padStart(6)} tokens (${metrics.activeObjectCount} objects)`);
    console.log(`  Peripheral stubs   : ${metrics.peripheralStubsTokens.toLocaleString().padStart(6)} tokens (${metrics.peripheralObjectCount} objects)`);
    console.log(`  Recent turns       : ${metrics.recentTurnsTokens.toLocaleString().padStart(6)} tokens${metrics.recentTurnsTruncated ? " [TRUNCATED]" : ""}`);
    console.log(`  Current input      : ${metrics.currentInputTokens.toLocaleString().padStart(6)} tokens`);
    console.log(`  --- Total: ${metrics.totalTokens.toLocaleString().padStart(6)} tokens ---`);
    console.log(`  --- Savings from tiering ---`);
    console.log(`  If all were active : ${savings.fullTokens.toLocaleString().padStart(6)} tokens`);
    console.log(`  With tiering       : ${savings.compactTokens.toLocaleString().padStart(6)} tokens`);
    console.log(`  Saved              : ${savings.savedTokens.toLocaleString().padStart(6)} tokens (${(savings.savingsRatio * 100).toFixed(1)}%)`);
  }

  console.log(`\n${"═".repeat(65)}`);
  console.log("  Core Hypothesis Test");
  console.log("  Does tiering prevent prompt truncation = higher budget for turns?");
  console.log(`\n  Custom params: npx tsx eval/token-benchmark.ts --objects 200 --ratio 0.1`);
  console.log(`${"═".repeat(65)}\n`);
}

main();
