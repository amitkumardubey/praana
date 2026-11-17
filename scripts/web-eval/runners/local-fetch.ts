import { fetchOutcome, httpUrl, isBotWall, readResponse, RunnerError, type Runner, type RunnerDeps } from "./base.js";

/** Intentionally simple, non-browser extraction. No JS execution or anti-bot evasion. */
export function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (!entity.startsWith("#")) return names[entity.toLowerCase()] ?? match;
      const number = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "�";
    }).replace(/\s+/g, " ").trim();
}

export function createLocalFetchRunner(deps: RunnerDeps = {}): Runner {
  return {
    id: "local-fetch", backend: "local-fetch", keyless: true,
    fetch: (url, maxChars) => fetchOutcome(deps, async () => {
      const { text, response } = await readResponse(deps, httpUrl(url));
      const type = response.headers.get("content-type") ?? "text/html";
      if (!/text\/|application\/(json|xml|xhtml\+xml)/i.test(type)) throw new RunnerError("other", response.status);
      return { content: /html/i.test(type) ? htmlText(text) : text, blocked: isBotWall(text), status: response.status };
    }, maxChars),
  };
}
