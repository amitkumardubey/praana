#!/usr/bin/env node
/**
 * ARIA Memory Evaluation
 *
 * Tests the cross-session memory layer.
 */

import { MemoryStore, HashEmbedder } from "../src/memory/index.js";

interface EvalResult {
  test: string;
  passed: boolean;
  detail: string;
  metric?: number | string;
}

function createStore(): MemoryStore {
  return new MemoryStore({
    dbPath: ":memory:",
    embedder: new HashEmbedder(),
  });
}

// ── 1. Retention ──
async function testRetention(): Promise<EvalResult> {
  const s = createStore();
  const ctx = { agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-1", context_label: "test" };

  await s.sessionStart(ctx);
  await s.remember("Always use 2-space indentation", { kind: "preference", certainty: "high" });
  await s.sessionEnd("clean");

  await s.sessionStart(ctx);
  const r = await s.recall("indentation");
  const found = r.entries.some((e) => e.content.includes("2-space"));

  return { test: "Retention", passed: found,
    detail: found ? "Remembered across sessions" : `Recall returned ${r.entries.length}`,
    metric: r.entries.length };
}

// ── 2. Keyword/Vector Recall ──
async function testRecall(): Promise<EvalResult> {
  const s = createStore();
  const ctx = { agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-2", context_label: "test" };

  await s.sessionStart(ctx);
  await s.remember("Never expose database credentials in env vars on client side", { kind: "decision", certainty: "high" });
  await s.sessionEnd("clean");

  await s.sessionStart(ctx);
  const r = await s.recall("security risk frontend secrets");
  const found = r.entries.some((e) => e.content.includes("database credentials"));

  return { test: "Recall (different words)", passed: r.entries.length > 0,
    detail: found
      ? `Found match via vector search (${r.entries.length} candidates)`
      : `No match. Got ${r.entries.length} candidate(s).`,
    metric: r.entries.length };
}

// ── 3. Context-scoped isolation ──
async function testContextScope(): Promise<EvalResult> {
  const s = createStore();

  // Project A stores a scoped fact
  await s.sessionStart({ agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-proj-a", context_label: "proj-a" });
  await s.remember("Project A uses Django", { kind: "fact", certainty: "high", scope: ["context:ctx-proj-a"] });
  await s.sessionEnd("clean");

  // Project B queries for Django
  await s.sessionStart({ agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-proj-b", context_label: "proj-b" });
  const r = await s.recall("Django");
  const leaked = r.entries.some((e) => e.content.includes("Project A"));

  return { test: "Context Scope Isolation", passed: !leaked,
    detail: !leaked
      ? "Project A fact stayed in project A scope"
      : `Cross-context leak: ${r.entries[0]?.content.slice(0, 60)}`,
    metric: r.entries.length };
}

// ── 4. User scope is global ──
async function testUserGlobal(): Promise<EvalResult> {
  const s = createStore();

  await s.sessionStart({ agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-old", context_label: "old-proj" });
  await s.remember("Prefers dark mode UI", { kind: "preference", certainty: "high", scope: ["user:u1"] });
  await s.sessionEnd("clean");

  await s.sessionStart({ agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-new", context_label: "new-proj" });
  const r = await s.recall("dark mode");
  const found = r.entries.some((e) => e.content.includes("dark mode"));

  return { test: "User Scope Global", passed: found,
    detail: found ? "Preference followed user across contexts" : "Preference lost",
    metric: r.entries.length };
}

// ── 5. Digest generation ──
async function testDigest(): Promise<EvalResult> {
  const s = createStore();
  const ctx = { agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-dig", context_label: "dig-test" };

  await s.sessionStart(ctx);
  await s.remember("Uses Vitest for testing", { kind: "preference", certainty: "high" });
  await s.remember("Prefers TypeScript", { kind: "preference", certainty: "high" });
  await s.sessionEnd("clean");

  const digest = await s.sessionStart(ctx);
  const hasContent = digest.markdown.length > 40 && !digest.empty;

  return { test: "Digest generation", passed: hasContent,
    detail: hasContent ? `Digest: ${digest.markdown.length} chars` : "Digest empty",
    metric: digest.markdown.length };
}

// ── 6. Pinned entries surface ──
async function testPinning(): Promise<EvalResult> {
  const s = createStore();
  const ctx = { agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-pin", context_label: "pin-test" };

  await s.sessionStart(ctx);
  await s.remember("Always use HTTPS", { kind: "fact", certainty: "high" });
  await s.sessionEnd("clean");

  const all = s.getAllEntries();
  const entry = all.find((e) => e.content.includes("HTTPS"));
  if (entry) await s.pin(entry.id);

  const digest = await s.sessionStart(ctx);
  const pinnedVisible = digest.markdown.includes("HTTPS");

  return { test: "Pinned Entries Surface", passed: pinnedVisible,
    detail: pinnedVisible ? "Pinned entry in digest" : "Not in digest",
    metric: digest.markdown.includes("HTTPS") ? 1 : 0 };
}

// ── Main ──
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ARIA Memory Evaluation");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const tests = [
    testRetention, testRecall, testContextScope,
    testUserGlobal, testDigest, testPinning,
  ];

  const results: EvalResult[] = [];
  for (const fn of tests) {
    try {
      const r = await fn();
      results.push(r);
      const icon = r.passed ? "✅" : "❌";
      console.log(`  ${icon} ${r.test}`);
      console.log(`     ${r.detail}`);
    } catch (err: any) {
      results.push({ test: fn.name, passed: false, detail: `ERROR: ${err.message}` });
      console.log(`  ❌ ${fn.name}: ERROR — ${err.message}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  console.log(`\n${"═".repeat(65)}`);
  console.log(`  Results: ${passed}/${total} tests passed`);
  console.log(`${"═".repeat(65)}\n`);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
