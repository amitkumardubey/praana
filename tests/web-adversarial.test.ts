import { describe, expect, it } from "bun:test";
import { webFetch } from "../src/tools/web/fetch.js";
import { sanitizeWebJson, sanitizeWebText } from "../src/tools/web/sanitize.js";
import { htmlToMarkdown } from "../src/tools/web/html-to-markdown.js";
import type { GuardTransport, HostLookup } from "../src/tools/web/ssrf.js";

const publicLookup: HostLookup = {
  async resolve() {
    return [{ address: "8.8.8.8", family: 4 }];
  },
};

function reply(body: string, contentType: string): GuardTransport {
  return {
    async exchange() {
      return {
        status: 200,
        headers: { "content-type": contentType },
        body: new TextEncoder().encode(body),
      };
    },
  };
}

/**
 * Regression tests for the quadratic-time findings from the OCR review:
 * adversarial remote input must not be able to freeze the agent with
 * synchronous work that the HTTP timeout cannot interrupt. Each test
 * builds the exact payload shape named in the review finding and bounds
 * its wall-clock time.
 */
describe("web_fetch adversarial-input regressions", () => {
  const BUDGET_MS = 5_000;

  it("sanitizes repeated unterminated OSC openers in linear time", () => {
    const adversarial = "\u001b]x".repeat(600_000);
    const start = performance.now();
    const clean = sanitizeWebText(adversarial);
    const elapsed = performance.now() - start;
    expect(clean).toBe("");
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("sanitizes repeated unterminated CSI openers in linear time", () => {
    const adversarial = "\u001b[".repeat(600_000);
    const start = performance.now();
    const clean = sanitizeWebText(adversarial);
    const elapsed = performance.now() - start;
    expect(clean).toBe("");
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("keeps ordinary text intact through the linear sanitizer", () => {
    const text = "see \u001b]8;;https://ok.example\u0007link\u001b]8;;\u0007 plain \u001b[31mred\u001b[0m and kept";
    expect(sanitizeWebText(text)).toBe("see link plain red and kept");
  });

  it("extracts markdown from repeated unterminated tags in linear time", () => {
    const adversarial = "<a ".repeat(600_000);
    const start = performance.now();
    const md = htmlToMarkdown(adversarial);
    const elapsed = performance.now() - start;
    expect(md).not.toContain("http");
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("extracts markdown from repeated false closing-tag prefixes in linear time", () => {
    // Every "</script" match is followed by "x", so the raw-text scan must
    // advance past each false prefix without rescanning or recopying the
    // document. Lowercasing per match froze the event loop for minutes.
    const adversarial = "<script>" + "</scriptx".repeat(44_000);
    const start = performance.now();
    const md = htmlToMarkdown(adversarial);
    const elapsed = performance.now() - start;
    expect(md).toBe("");
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("extracts markdown from many small raw-text elements in linear time", () => {
    // One full-document lowercase per <script> element is also quadratic.
    const adversarial = "<script>1</script>".repeat(80_000);
    const start = performance.now();
    const md = htmlToMarkdown(adversarial);
    const elapsed = performance.now() - start;
    expect(md).toBe("");
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("extracts markdown from dense paired tags in linear time", () => {
    // The tag-name regex used to run over `html.slice(from)`, copying the
    // rest of the document per tag token; dense paired tags made that quadratic.
    const adversarial = "<b>x</b>".repeat(150_000); // ~1.2 MB of pairs
    const start = performance.now();
    const md = htmlToMarkdown(adversarial);
    const elapsed = performance.now() - start;
    expect(md.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("extracts markdown from an unterminated comment in linear time", () => {
    const adversarial = `<!--${"x".repeat(600_000)}`;
    const start = performance.now();
    const md = htmlToMarkdown(`${adversarial}<p>never rendered</p>`);
    const elapsed = performance.now() - start;
    expect(md).toBe("");
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("does not amplify a deeply nested JSON response into memory blowup", async () => {
    // ~1 MiB of nested arrays under the 2 MiB download cap. Indented
    // serialization would produce ~500 MB of output; compact bounded
    // serialization must stay under maxChars plus the banner.
    let deep: unknown = Array.from({ length: 500_000 }, () => 0);
    for (let i = 0; i < 400; i += 1) deep = [deep];
    const body = JSON.stringify(deep);
    expect(body.length).toBeLessThan(2 * 1024 * 1024);

    const start = performance.now();
    const result = await webFetch("https://example.com/deep", {
      lookup: publicLookup,
      transport: reply(body, "application/json"),
      maxChars: 2_000,
    });
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.length).toBeLessThan(2_500);
    expect(result.truncated).toBe(true);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("renders a large flat JSON array bounded, not exploded", async () => {
    const body = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => i));
    expect(body.length).toBeGreaterThan(200_000);
    const result = await webFetch("https://example.com/arr", {
      lookup: publicLookup,
      transport: reply(body, "application/json"),
      maxChars: 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.length).toBeLessThan(700);
    expect(result.truncated).toBe(true);
  });

  it("focus input is capped: a huge repetitive focus cannot stall scoring", async () => {
    const body = "a".repeat(19_000);
    const start = performance.now();
    const result = await webFetch("https://example.com/f", {
      lookup: publicLookup,
      transport: reply(body, "text/plain"),
      focus: "aa ".repeat(20_000),
    });
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("a __proto__ JSON key does not lose the object", async () => {
    const result = await webFetch("https://example.com/proto", {
      lookup: publicLookup,
      transport: reply('{"__proto__":{"x":1},"real":2}', "application/json"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('"real"');
  });

  it("void elements (input/link/meta) do not discard the rest of the page", () => {
    const html = '<input class="cookie-consent"><article><p>Readable content</p></article>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("Readable content");
  });

  it("a quoted data-href never wins over the real href", () => {
    const html = '<a data-href="/preview" href="/actual">Read</a>';
    const md = htmlToMarkdown(html, "https://example.com/");
    expect(md).toContain("](https://example.com/actual)");
    expect(md).not.toContain("/preview");
  });

  it("a data-class attribute never triggers consent chrome skipping", () => {
    const html = '<div data-class="cookie"><p>Kept content</p></div>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("Kept content");
  });

  it("raw-text elements consume to their literal close, not by nesting", () => {
    const html = '<script>const t = "<script>";</script><p>After the script</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("After the script");
  });

  it("entity-decoded hrefs resolve with their query parameters intact", () => {
    const html = '<a href="/search?q=foo&amp;page=2">next</a>';
    const md = htmlToMarkdown(html, "https://example.com/base");
    expect(md).toContain("](https://example.com/search?q=foo&page=2)");
  });

  it("bounds a stalled DNS lookup with the fetch timeout", async () => {
    // The HTTP exchange has its own timer, but a resolver that never answers
    // used to keep the turn waiting past timeout_ms. The guard phase now shares
    // the deadline.
    const stalled: HostLookup = { resolve: () => new Promise<never>(() => {}) };
    const start = performance.now();
    const result = await webFetch("https://example.com/x", {
      lookup: stalled,
      transport: reply("x", "text/plain"),
      timeoutMs: 100,
    });
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/timed out/i);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("aborts a stalled DNS lookup when the signal fires", async () => {
    const stalled: HostLookup = { resolve: () => new Promise<never>(() => {}) };
    const controller = new AbortController();
    const pending = webFetch("https://example.com/x", {
      lookup: stalled,
      transport: reply("x", "text/plain"),
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    const result = await pending;
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/aborted/i);
    expect(elapsed).toBeLessThan(2_000);
  });
});
