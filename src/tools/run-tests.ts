/**
 * Structured test runner tool (issue #321) — part of the deterministic tools harness (#195).
 *
 * Dispatches test execution to language-specific adapters and returns structured pass/fail
 * counts and failure excerpts instead of unstructured terminal logs.
 */

import { z } from "zod";
import { defineTool } from "./tool-def.js";
import { executeTests } from "./test-runner/runner.js";
import type { RunTestsContext, RunTestsResult } from "./test-runner/types.js";

export const runTestsSchema = z.object({
  command: z
    .string()
    .optional()
    .describe(
      "Explicit test command override (e.g. 'bun test', 'npm test -- -t auth', 'go test ./...', 'cargo test', 'pytest')",
    ),
  files: z
    .array(z.string())
    .optional()
    .describe("Specific test file paths to run (relative to cwd or absolute)"),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe("Execution timeout in milliseconds (default 30000)"),
  runner: z
    .enum(["bun", "npm", "pnpm", "yarn", "go", "cargo", "pytest", "custom"])
    .optional()
    .describe("Runner hint (auto-detected from repo if omitted)"),
});

export type RunTestsArgs = z.infer<typeof runTestsSchema>;

export function createRunTestsTool(ctx: RunTestsContext) {
  return {
    run_tests: defineTool({
      description:
        "Execute project test suites and return structured pass/fail/skipped counts, duration, and failure excerpts. Auto-detects runner (bun, npm/pnpm/yarn, go, cargo, pytest) or accepts an explicit command override. Large output is preserved as a retrievable artifact.",
      parameters: runTestsSchema,
      execute: async (raw: unknown): Promise<RunTestsResult> => {
        const parsed = runTestsSchema.safeParse(raw ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
            code: "invalid_arguments",
          };
        }

        return executeTests({
          cwd: ctx.cwd,
          command: parsed.data.command,
          files: parsed.data.files,
          timeout_ms: parsed.data.timeout_ms,
          runner: parsed.data.runner,
          sandbox: ctx.sandbox,
          getAbortSignal: ctx.getAbortSignal,
        });
      },
    }),
  };
}
