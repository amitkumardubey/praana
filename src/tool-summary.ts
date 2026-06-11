/** Compact summaries for tool call / result display in terminal and TUI. */

export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return String(args.path ?? "");
    case "shell":
      return String(args.command ?? "").slice(0, 80);
    case "create_task":
      return String(args.title ?? "");
    case "complete_task":
    case "hydrate":
    case "soft_unload":
    case "hard_unload":
      return String(args.id ?? "").slice(0, 26);
    case "add_constraint":
    case "add_note":
      return String(args.text ?? "").slice(0, 60);
    case "decide":
      return String(args.summary ?? "").slice(0, 60);
    case "recall":
    case "search_session_log":
      return String(args.query ?? "").slice(0, 60);
    case "remember":
      return String(args.content ?? "").slice(0, 60);
    default:
      return Object.entries(args)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
        .join(", ")
        .slice(0, 80);
  }
}

export function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "done";
  if (typeof result !== "object") return String(result).slice(0, 120);

  const r = result as Record<string, unknown>;
  if (r.ok === false && r.error) return `error: ${String(r.error).slice(0, 100)}`;
  if (r.ok === true || r.ok === undefined) {
    if (typeof r.stdout === "string" && r.stdout.length > 0) {
      const lines = r.stdout.trim().split("\n").length;
      return `exit ${r.exitCode ?? 0}, ${lines} line(s)`;
    }
    if (typeof r.content === "string") {
      return `${r.content.length} chars`;
    }
    if (typeof r.output === "string") {
      return r.output.slice(0, 100);
    }
    if (r.id) return `id ${String(r.id).slice(0, 26)}`;
  }
  return JSON.stringify(result).slice(0, 100);
}
