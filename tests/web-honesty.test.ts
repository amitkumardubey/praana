import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardTransport, HostLookup } from "../src/tools/web/ssrf.js";
import { webFetch, type WebFetchResult } from "../src/tools/web/fetch.js";

const publicLookup: HostLookup = {
  async resolve() {
    return [{ address: "8.8.8.8", family: 4 }];
  },
};

const fixtureDir = join(import.meta.dir, "fixtures/web");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

async function fetchHtml(
  html: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Promise<WebFetchResult> {
  const transport: GuardTransport = {
    async exchange() {
      return {
        status,
        headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
        body: new TextEncoder().encode(html),
      };
    },
  };
  return webFetch("https://example.com/page", { lookup: publicLookup, transport });
}

function assertBlocked(result: WebFetchResult, reason: RegExp): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.blocked).toBe(true);
  expect(result.reason).toMatch(reason);
  expect(JSON.stringify(result)).not.toContain("WALLTOKEN");
}

describe("bot walls and empty shells", () => {
  const files: Array<{ file: string; reason: RegExp }> = [
    { file: "cloudflare-just-a-moment.html", reason: /cloudflare/i },
    { file: "cloudflare-attention.html", reason: /cloudflare/i },
    { file: "cloudflare-cf-chl.html", reason: /cloudflare/i },
    { file: "akamai.html", reason: /akamai/i },
    { file: "datadome.html", reason: /datadome/i },
    { file: "perimeterx.html", reason: /perimeterx/i },
    { file: "imperva.html", reason: /imperva/i },
    { file: "hcaptcha.html", reason: /hcaptcha/i },
    { file: "recaptcha.html", reason: /recaptcha/i },
    { file: "turnstile.html", reason: /turnstile/i },
    { file: "verify-human.html", reason: /human|challenge/i },
    { file: "enable-js.html", reason: /javascript|challenge/i },
    { file: "login-wall.html", reason: /login/i },
  ];

  for (const c of files) {
    it(`blocks ${c.file} without returning the wall`, async () => {
      assertBlocked(await fetchHtml(readFixture(c.file)), c.reason);
    });
  }

  it("blocks an empty script-rendered shell", async () => {
    const html = `${readFixture("empty-shell.html")}<!-- ${"x".repeat(2000)} -->`;
    const result = await fetchHtml(html);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("empty or script-rendered page");
    expect(JSON.stringify(result)).not.toContain("WALLTOKEN");
  });

  it("blocks challenge status codes only when a challenge marker is present", async () => {
    const marked = await fetchHtml(readFixture("cloudflare-attention.html"), 403);
    assertBlocked(marked, /cloudflare/i);

    const header = await fetchHtml("<html><body><p>WALLTOKEN</p></body></html>", 503, {
      "cf-mitigated": "challenge",
    });
    assertBlocked(header, /cloudflare/i);

    const limited = await fetchHtml("<html><body><p>slow down please, this is a long ordinary notice.</p></body></html>", 429);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.blocked).not.toBe(true);
      expect(limited.reason).toContain("429");
    }

    const denied = await fetchHtml("<html><body><p>You do not have access to this file.</p></body></html>", 401);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.blocked).not.toBe(true);
      expect(denied.reason).toContain("401");
    }
  });

  it("returns articles that only mention Cloudflare or captcha", async () => {
    const cloudflare = await fetchHtml(readFixture("article-cloudflare.html"));
    expect(cloudflare.ok).toBe(true);
    if (cloudflare.ok) expect(cloudflare.content).toContain("Cloudflare");

    const captcha = await fetchHtml(readFixture("article-captcha.html"));
    expect(captcha.ok).toBe(true);
    if (captcha.ok) expect(captcha.content.toLowerCase()).toContain("captcha");
  });
});
