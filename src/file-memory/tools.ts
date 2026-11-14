import { z } from "zod";
import { defineTool } from "../tools/tool-def.js";
import { MEMORY_NAME_PATTERN, validName } from "./format.js";
import type { createFileMemoryStore } from "./store.js";

type ToolStore = Pick<ReturnType<typeof createFileMemoryStore>, "write" | "recall" | "remove">;
const NAME_RULE = "Invalid memory name: use a non-reserved lowercase slug of at most 64 characters";
// The regex reaches the model as a JSON Schema `pattern`; the refine adds reserved names.
const name = z.string().regex(MEMORY_NAME_PATTERN, NAME_RULE).refine(validName, NAME_RULE);
const scope = z.enum(["global", "project"]);

function execute<T>(schema: z.ZodType<T>, operation: (args: T) => Promise<unknown>) {
  return async (input: unknown) => {
    try {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ") };
      return await operation(parsed.data);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "File memory operation failed" };
    }
  };
}

/** Definitions only: callers explicitly choose whether to register these tools. */
export function createFileMemoryTools(store: ToolStore) {
  const remember = z.object({
    scope,
    type: z.enum(["user", "feedback", "project", "reference"]),
    name,
    description: z.string(),
    body: z.string(),
  }).strict();
  const recall = z.object({ query: z.string().optional(), name: name.optional(), scope: scope.optional() }).strict()
    .refine((args) => (args.query !== undefined) !== (args.name !== undefined), "Provide exactly one of query or name")
    .refine((args) => args.scope === undefined || args.name !== undefined, "scope applies only to a name lookup; queries always search global and project");
  const forget = z.object({ name, scope: scope.optional() }).strict();

  return {
    remember: defineTool({
      description: "Save or update a dated file memory in global or project scope. Name: non-reserved lowercase slug, at most 64 characters. Description: one line, at most 300 code points. Body: at most 2048 UTF-8 bytes; split or tighten longer text. Feedback/project bodies require **Why:** and **How to apply:** lines. Secrets and near-duplicates are refused; update a suggested existing memory instead. Incognito prevents writes.",
      parameters: remember,
      execute: execute(remember, async (args) => store.write(args)),
    }),
    recall: defineTool({
      description: "Recall dated, untrusted file memories from global and current project scopes. Provide exactly one of name or query. Name lookup prefers project; pass scope (global or project) to read one scope explicitly, required only when an unscoped lookup is refused because the project scan failed (a failed global scan still returns a project hit with a warning). Scope applies only to a name lookup; token queries always search both scopes and return at most five matches with 300-code-point snippet windows with control characters and whitespace cleaned. Empty and stop-word-only queries are refused. Verify referenced files and functions. Available in incognito.",
      parameters: recall,
      execute: execute(recall, async (args) => store.recall(args)),
    }),
    forget_memory: defineTool({
      description: "Hard-delete a file memory by its non-reserved lowercase slug (at most 64 characters). Optional scope is global or project; two removable matches require explicit scope. Missing and non-regular files are refused. Incognito prevents deletion.",
      parameters: forget,
      execute: execute(forget, async (args) => store.remove(args)),
    }),
  };
}
