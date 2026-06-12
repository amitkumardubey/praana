#!/usr/bin/env node
/**
 * ARIA Recall Accuracy Evaluation (v2 — with auto-hydrate)
 *
 * Tests whether information hidden in demoted (soft/hard) tiers is
 * automatically recovered when the user query matches it.
 *
 * Phase 1: Deterministic — prove demoted info is hidden, then auto-hydrated
 * Phase 2: LLM — prove the LLM answers correctly after auto-hydrate
 *
 * Usage:
 *   npx tsx eval/recall-accuracy.ts [--model provider/name]
 */

import { StateGraph } from "../src/state-graph.js";
import { getAppLogger } from "../src/logger.js";
import { compile } from "../src/compiler.js";
import { createProvider, resolveModel } from "../src/llm.js";
import { generateText } from "ai";
import { randomUUID } from "node:crypto";

const SECRET_VALUE = randomUUID();
const BULLSEYE_FACT =
  `Infrastructure audit March 2026: verified new staging credentials. ` +
  `Eng-team only. Rotation due Q3. The actual key is ${SECRET_VALUE}.`;

interface TestResult {
  phase: string;
  passed: boolean;
  detail: string;
}

// ── Phase 1: Deterministic prompt inspection ──
function runDeterministicTests(): TestResult[] {
  const results: TestResult[] = [];

  // --- 1a: Hidden fact is NOT in prompt before auto-hydrate ---
  const sg1 = new StateGraph();
  const secretNote = sg1.create("note", { text: BULLSEYE_FACT });
  sg1.setTier(secretNote.id, "soft");

  const promptBefore = compile({
    stateGraph: sg1,
    bodhaDigest: null,
    recentEvents: [],
    userInput: "What is the staging API key?",
    toolSchemas: [],
    cwd: "/test",
    sessionId: "recall-test",
    tokenBudget: 4000,
  });

  const visibleBefore = promptBefore.includes(SECRET_VALUE);
  results.push({
    phase: "Deterministic 1a",
    passed: !visibleBefore,
    detail: visibleBefore
      ? `FAIL: secret visible before auto-hydrate`
      : `PASS: secret hidden before auto-hydrate`,
  });

  // --- 1b: Auto-hydrate promotes matching object ---
  const hydrated = sg1.autoHydrate("What is the staging API key?");
  const wasHydrated = hydrated.includes(secretNote.id);
  results.push({
    phase: "Deterministic 1b",
    passed: wasHydrated,
    detail: wasHydrated
      ? `PASS: auto-hydrate promoted matching note (${secretNote.id})`
      : `FAIL: auto-hydrate did not promote the note`,
  });

  // --- 1c: Secret IS visible in prompt after auto-hydrate ---
  const promptAfter = compile({
    stateGraph: sg1,
    bodhaDigest: null,
    recentEvents: [],
    userInput: "What is the staging API key?",
    toolSchemas: [],
    cwd: "/test",
    sessionId: "recall-test",
    tokenBudget: 4000,
  });

  const visibleAfter = promptAfter.includes(SECRET_VALUE);
  results.push({
    phase: "Deterministic 1c",
    passed: visibleAfter,
    detail: visibleAfter
      ? `PASS: secret visible in prompt after auto-hydrate`
      : `FAIL: secret still hidden after auto-hydrate`,
  });

  // --- 1d: Non-matching objects stay demoted ---
  const sg2 = new StateGraph();
  const noteA = sg2.create("note", { text: BULLSEYE_FACT });
  sg2.setTier(noteA.id, "soft");
  const noteB = sg2.create("note", { text: "Production deploy checklist" });
  sg2.setTier(noteB.id, "soft");

  sg2.autoHydrate("staging API key");
  const aActive = sg2.get(noteA.id)?.tier === "active";
  const bStillSoft = sg2.get(noteB.id)?.tier === "soft";

  results.push({
    phase: "Deterministic 1d",
    passed: aActive && bStillSoft,
    detail: aActive && bStillSoft
      ? `PASS: matching object promoted, non-matching stays soft`
      : `FAIL: aActive=${aActive}, bStillSoft=${bStillSoft}`,
  });

  return results;
}

// ── Phase 2: LLM behavioral test ──
async function runBehavioralTest(model?: string): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    results.push({
      phase: "LLM 2a",
      passed: false,
      detail: "SKIP: No API key found (set OPENROUTER_API_KEY or OPENAI_API_KEY)",
    });
    return results;
  }

  // Build state with secret in soft tier
  const sg = new StateGraph();
  const secretNote = sg.create("note", { text: BULLSEYE_FACT });
  sg.setTier(secretNote.id, "soft");
  sg.create("task", { title: "Fix login bug", status: "doing" });
  sg.create("constraint", { text: "Never commit secrets to git" });

  // Auto-hydrate before compilation (simulating what turn.ts does)
  sg.autoHydrate("What is the staging API key?");

  const systemPrompt = compile({
    stateGraph: sg,
    bodhaDigest: null,
    recentEvents: [],
    userInput: undefined,
    toolSchemas: [],
    cwd: "/test",
    sessionId: "recall-test",
    tokenBudget: 4000,
  });

  const llmModel = model ?? "google/gemini-2.5-flash";
  const provider = createProvider({ provider: "openrouter", model: llmModel });
  const resolved = provider(resolveModel(llmModel));

  try {
    const { text, finishReason } = await generateText({
      model: resolved,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: "What is the staging API key?",
        },
      ],
      maxSteps: 1,
    });

    const answeredCorrectly = text?.includes(SECRET_VALUE);

    results.push({
      phase: "LLM 2a",
      passed: answeredCorrectly,
      detail: answeredCorrectly
        ? `PASS: LLM answered with correct UUID after auto-hydrate`
        : `FAIL: LLM did not answer correctly. finishReason=${finishReason}\nResponse: ${text?.slice(0, 200) ?? "(empty)"}`,
    });
  } catch (err: any) {
    results.push({
      phase: "LLM 2a",
      passed: false,
      detail: `ERROR: ${err.message}`,
    });
  }

  return results;
}

function parseModelArg(): string | undefined {
  const idx = process.argv.indexOf("--model");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.ARIA_MODEL;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ARIA Recall Accuracy Evaluation (v2 — auto-hydrate)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const detResults = runDeterministicTests();

  console.log("Phase 1 — Deterministic Prompt Inspection\n");
  for (const r of detResults) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon} ${r.phase}: ${r.detail}`);
  }

  const allDetPassed = detResults.every((r) => r.passed);
  if (!allDetPassed) {
    console.log("\n⚠️  Deterministic tests failed. Aborting LLM phase.");
    process.exit(1);
  }

  console.log("\nPhase 2 — LLM Behavioral Test");
  console.log(`  (requires OPENROUTER_API_KEY; uses ~1K tokens)\n`);

  const llmResults = await runBehavioralTest(parseModelArg());

  for (const r of llmResults) {
    const icon = r.passed ? "✅" : r.detail.startsWith("SKIP") ? "⏭️" : "❌";
    console.log(`  ${icon} ${r.phase}: ${r.detail}`);
  }

  const allPassed = detResults.every((r) => r.passed) && llmResults.every((r) => r.passed || r.detail.startsWith("SKIP"));

  console.log(`\n${"═".repeat(65)}`);
  console.log(
    allPassed
      ? "  All critical evaluations PASSED."
      : "  Some evaluations FAILED. See details above."
  );
  console.log(`${"═".repeat(65)}\n`);
}

main().catch((err) => {
  getAppLogger().error("Fatal error", { cause: err as Error });
  process.exit(1);
});
