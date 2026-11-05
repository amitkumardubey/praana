import { classifyError, readResponse, RunnerError, type RunnerDeps } from "./base.js";

export async function jsonRequest(deps: RunnerDeps, url: string, headers: Record<string, string>, body?: unknown): Promise<{ data: any; status: number }> {
  const { text, response } = await readResponse(deps, url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || data.success === false || data.error) throw new RunnerError(classifyError(undefined, JSON.stringify(data?.error ?? "")), response.status);
  return { data, status: response.status };
}

export function envKey(deps: RunnerDeps, name: string): string | undefined {
  return (deps.env ?? process.env)[name]?.trim() || undefined;
}
export function credits(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
