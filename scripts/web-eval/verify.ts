import { readFile } from "node:fs/promises";
import { isBotWallTask, validateTasks, verifyTask, type FetchTask, type SearchTask } from "./tasks.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Redirects and retry attempts are individually paced, not hidden inside fetch. */
export async function fetchPage(url: string, fetcher: typeof fetch = fetch, delay = sleep): Promise<Response> {
  let current = url;
  let retries = 0;
  for (let request = 0; request < 10; request++) {
    if (request > 0) await delay(retries ? Math.min(30_000, 1000 * 2 ** retries) : 1000);
    const response = await fetcher(current, {
      headers: { "User-Agent": "praana-web-eval/0.1" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect without Location");
      const next = new URL(location, current);
      if (next.protocol !== "https:" && next.protocol !== "http:") throw new Error("invalid redirect protocol");
      current = next.href;
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && retries < 2) {
      retries++;
      continue;
    }
    return response;
  }
  throw new Error("too many redirects or retries");
}

async function visibleText(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) return response.text();
  let text = "";
  const transformed = new HTMLRewriter()
    .on("script, style, template, noscript", { element(element) { element.remove(); } })
    .onDocument({ text(chunk) { text += chunk.text; } })
    .transform(response);
  await transformed.arrayBuffer();
  return text.replace(/\s+/g, " ");
}

async function main(): Promise<void> {
  const [kindArg, path] = process.argv.slice(2);
  if ((kindArg !== "search" && kindArg !== "fetch") || !path) {
    throw new Error("Usage: bun scripts/web-eval/verify.ts <search|fetch> <tasks.json>");
  }
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  const errors = validateTasks(kindArg, input);
  if (errors.length) throw new Error(`Invalid task set:\n${errors.join("\n")}`);
  const tasks = input as (SearchTask | FetchTask)[];
  let failures = 0;
  let walls = 0;
  for (const [index, task] of tasks.entries()) {
    if (index) await sleep(1000);
    const isFetch = !("answer_snippets" in task);
    const url = isFetch ? (task as FetchTask).url : (task as SearchTask).authoritative_url;
    const botWall = isFetch && isBotWallTask(task as FetchTask);
    try {
      const response = await fetchPage(url);
      const text = await visibleText(response);
      if (!response.ok && !botWall) throw new Error(`HTTP ${response.status}`);
      const missing = verifyTask(task, text);
      if (missing.length) throw new Error(`missing: ${JSON.stringify(missing)}`);
      if (botWall) {
        walls++;
        const recorded = (task as FetchTask).observed_status;
        if (response.status !== recorded) {
          console.warn(`WARN ${index + 1} ${url}: status ${response.status} differs from recorded ${recorded}`);
        }
        console.log(`PASS tier3 ${index + 1} ${url} status=${response.status} marker=${JSON.stringify((task as FetchTask).probe)}`);
        continue;
      }
      console.log(`PASS ${index + 1} ${url}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${index + 1} ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(
    `${tasks.length - failures}/${tasks.length} verified on ${new Date().toISOString().slice(0, 10)}` +
      `${walls ? ` (${walls} tier 3 challenge pages confirmed)` : ""}; dates are not updated automatically.`,
  );
  if (failures) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
