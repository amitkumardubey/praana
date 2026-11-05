/**
 * GET a URL that has already passed the SSRF guard and turn the body into
 * bounded text. The socket uses the pin from the guard (`pin.lookup`), so the
 * connection target is the address that was checked. No cookies, no
 * Authorization, and no request credentials are sent.
 */

import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate, type BrotliDecompress, type Gunzip, type Inflate } from "node:zlib";
import { APP_VERSION } from "../../app-version.js";
import { fetchGuarded, type GuardPin, type GuardTransport, type HostLookup } from "./ssrf.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { blockReason } from "./honesty.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 20_000;
export const HARD_MAX_CHARS = 100_000;

export interface WebFetchOptions {
  lookup?: HostLookup;
  transport?: GuardTransport;
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  focus?: string;
  signal?: AbortSignal;
}

export type WebFetchResult =
  | {
      ok: true;
      url: string;
      final_url: string;
      status: number;
      content_type: string;
      truncated: boolean;
      bytes: number;
      content: string;
    }
  | { ok: false; reason: string; blocked?: boolean };

type Decoder = Gunzip | BrotliDecompress | Inflate;

export function praanaUserAgent(): string {
  const version = APP_VERSION.replace(/^v/, "");
  return `praana/${version}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function httpHostname(url: URL): string {
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function headerValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string");
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

function decoderFor(encoding: string | undefined): Decoder | null {
  const name = encoding?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (name === "" || name === "identity") return null;
  if (name === "gzip" || name === "x-gzip") return createGunzip();
  if (name === "br") return createBrotliDecompress();
  if (name === "deflate") return createInflate();
  throw new Error(`unsupported content-encoding ${name}`);
}

/**
 * One HTTP GET to an already-validated pin. Does not follow redirects.
 * Aborts once the raw download or the decoded body exceeds `maxBytes`.
 */
export function exchangePinned(
  pin: GuardPin,
  opts: { timeoutMs: number; maxBytes: number; userAgent?: string; signal?: AbortSignal },
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  const maxBytes = opts.maxBytes;
  const userAgent = opts.userAgent ?? praanaUserAgent();
  const hostname = httpHostname(pin.url);

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    let settled = false;
    let decoder: Decoder | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: http.ClientRequest | undefined;
    const finish = (err: Error | null, value?: { status: number; headers: Record<string, string>; body: Uint8Array }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else if (value) resolve(value);
    };
    const fail = (err: Error) => {
      decoder?.destroy();
      req?.destroy();
      finish(err);
    };
    const onAbort = () => fail(new Error("aborted"));

    const options: https.RequestOptions = {
      protocol: pin.url.protocol,
      hostname,
      port: pin.url.port ? Number(pin.url.port) : undefined,
      method: "GET",
      path: `${pin.url.pathname}${pin.url.search}` || "/",
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/json,text/plain,text/markdown;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      },
      lookup: pin.lookup as https.RequestOptions["lookup"],
      servername: pin.url.protocol === "https:" && !isIpLiteral(hostname) ? hostname : undefined,
    };

    const onResponse = (res: http.IncomingMessage) => {
      try {
        decoder = decoderFor(headerValue(res.headers["content-encoding"]));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(errorMessage(err)));
        return;
      }

      const chunks: Buffer[] = [];
      let rawBytes = 0;
      let outBytes = 0;

      const cap = () => fail(new Error(`response exceeded ${maxBytes} byte download cap`));
      const takeRaw = (buf: Buffer) => {
        rawBytes += buf.length;
        if (rawBytes > maxBytes) cap();
      };
      const takeOut = (buf: Buffer) => {
        outBytes += buf.length;
        if (outBytes > maxBytes) {
          cap();
          return;
        }
        chunks.push(buf);
      };
      const asBuffer = (chunk: Buffer | string) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk);

      const done = () => {
        if (settled) return;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (key.toLowerCase() === "content-encoding") continue;
          const text = headerValue(value);
          if (text === undefined) continue;
          headers[key.toLowerCase()] = text;
        }
        finish(null, {
          status: res.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks),
        });
      };

      res.on("error", (err) => fail(err));
      if (decoder) {
        decoder.on("data", (chunk: Buffer | string) => takeOut(asBuffer(chunk)));
        decoder.on("error", (err) => fail(err));
        decoder.on("end", done);
        res.on("data", (chunk: Buffer | string) => {
          const buf = asBuffer(chunk);
          takeRaw(buf);
          if (!settled) decoder?.write(buf);
        });
        res.on("end", () => {
          if (!settled) decoder?.end();
        });
      } else {
        res.on("data", (chunk: Buffer | string) => {
          const buf = asBuffer(chunk);
          takeRaw(buf);
          if (!settled) takeOut(buf);
        });
        res.on("end", done);
      }
    };

    req = (pin.url.protocol === "https:" ? https : http).request(options, onResponse);
    timer = setTimeout(() => fail(new Error(`timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
    req.on("error", (err) => {
      if (!settled) fail(err);
    });
    req.on("timeout", () => fail(new Error(`timed out after ${opts.timeoutMs}ms`)));
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

function mediaType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function charsetOf(contentType: string): string | undefined {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1]?.trim();
}

function decodeBytes(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function decodeDocument(body: Uint8Array, contentType: string, type: string): string {
  const headerCharset = charsetOf(contentType);
  if (headerCharset) return decodeBytes(body, headerCharset).replace(/^\uFEFF/, "");
  if (type === "text/html" || type === "application/xhtml+xml" || type === "") {
    const sniff = Buffer.from(body.subarray(0, 2048)).toString("latin1");
    const meta = /charset\s*=\s*["']?\s*([^"'\s/>;]+)/i.exec(sniff);
    if (meta?.[1]) return decodeBytes(body, meta[1]).replace(/^\uFEFF/, "");
  }
  return decodeBytes(body, "utf-8").replace(/^\uFEFF/, "");
}

function looksLikePdf(body: Uint8Array): boolean {
  return Buffer.from(body.subarray(0, 5)).toString("latin1").startsWith("%PDF-");
}

function textual(type: string): boolean {
  if (type.startsWith("text/")) return true;
  if (type === "application/json" || type.endsWith("+json")) return true;
  if (type === "application/xml" || type === "application/xhtml+xml") return true;
  if (type === "application/javascript") return true;
  return false;
}

function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(value), HARD_MAX_CHARS);
}

function termsOf(focus: string): string[] {
  const terms = focus.toLowerCase().split(/[^a-z0-9]+/i).filter((term) => term.length >= 2);
  if (terms.length > 0) return terms;
  const raw = focus.trim().toLowerCase();
  return raw ? [raw] : [];
}

function countTerm(haystack: string, term: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(term, from);
    if (at === -1) break;
    count += 1;
    from = at + term.length;
  }
  return count;
}

function blocksOf(markdown: string): string[] {
  if (/^#{1,6} /m.test(markdown)) {
    return markdown.split(/^(?=#{1,6} )/m).map((part) => part.trim()).filter(Boolean);
  }
  return markdown.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

function applyFocus(markdown: string, focus: string | undefined): string {
  const query = focus?.trim();
  if (!query) return markdown;
  const terms = termsOf(query);
  if (terms.length === 0) return markdown;
  const blocks = blocksOf(markdown);
  const ranked = blocks.map((text, index) => {
    const lower = text.toLowerCase();
    const heading = /^#{1,6} [^\n]*/.exec(lower)?.[0] ?? "";
    let score = 0;
    for (const term of terms) {
      score += countTerm(lower, term);
      if (heading.includes(term)) score += 2;
    }
    return { text, index, score };
  });
  const hits = ranked.filter((block) => block.score > 0);
  if (hits.length === 0) {
    return `No section matched focus; showing the start of the page.\n\n${markdown}`;
  }
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return hits.map((block) => block.text).join("\n\n");
}

function boundText(text: string, maxChars: number, total: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  const slice = text.slice(0, maxChars);
  const notice = `\n\n[truncated to ${slice.length} of ${total} characters; pass focus to narrow]`;
  return { content: `${slice}${notice}`, truncated: true };
}

function renderBody(text: string, type: string, pageUrl: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch (err) {
      return { ok: false, reason: `response was not valid JSON (${errorMessage(err)})` };
    }
  }
  if (type === "text/html" || type === "application/xhtml+xml") {
    return { ok: true, text: htmlToMarkdown(text, pageUrl) };
  }
  return { ok: true, text };
}

export async function webFetch(input: string, opts: WebFetchOptions = {}): Promise<WebFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const transport = opts.transport ?? {
    exchange: (pin: GuardPin) =>
      exchangePinned(pin, {
        timeoutMs,
        maxBytes,
        userAgent: praanaUserAgent(),
        signal: opts.signal,
      }),
  };

  let raw: Awaited<ReturnType<typeof fetchGuarded>>;
  try {
    raw = await fetchGuarded(input, { lookup: opts.lookup, transport });
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }
  if (!raw.ok) return raw;

  const contentType = header(raw.headers, "content-type") ?? "";
  const type = mediaType(contentType);
  if (type === "application/pdf" || ((type === "" || type === "application/octet-stream") && looksLikePdf(raw.body))) {
    return { ok: false, reason: "PDF extraction is not supported" };
  }
  if (type !== "" && !textual(type)) {
    return { ok: false, reason: `binary content (${type}) is not supported` };
  }

  const text = decodeDocument(raw.body, contentType, type);
  const effectiveType = type || (text.trimStart().startsWith("<") ? "text/html" : "text/plain");
  const extracted = effectiveType === "text/html" || effectiveType === "application/xhtml+xml"
    ? htmlToMarkdown(text, raw.finalUrl)
    : text;
  const blocked = blockReason({
    status: raw.status,
    headers: raw.headers,
    raw: text,
    text: extracted,
    contentType: effectiveType,
  });
  if (blocked) return { ok: false, blocked: true, reason: blocked };
  if (raw.status < 200 || raw.status >= 300) {
    return { ok: false, reason: `HTTP ${raw.status}` };
  }

  const rendered = effectiveType === "text/html" || effectiveType === "application/xhtml+xml"
    ? { ok: true as const, text: extracted }
    : renderBody(text, effectiveType, raw.finalUrl);
  if (!rendered.ok) return rendered;

  const total = rendered.text.length;
  const focused = applyFocus(rendered.text, opts.focus);
  const bounded = boundText(focused, clampMaxChars(opts.maxChars), opts.focus?.trim() ? total : focused.length);
  return {
    ok: true,
    url: input,
    final_url: raw.finalUrl,
    status: raw.status,
    content_type: contentType || effectiveType,
    truncated: bounded.truncated,
    bytes: raw.body.byteLength,
    content: bounded.content,
  };
}
