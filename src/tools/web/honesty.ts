/**
 * Decide when a response is a wall or an empty shell instead of a page.
 * Marker strings are specific so an article that merely mentions a vendor
 * still counts as content.
 */

export interface PageSignals {
  status: number;
  headers: Record<string, string>;
  /** Decoded response body. */
  raw: string;
  /** Text a reader would see after HTML extraction. */
  text: string;
  contentType: string;
}

const MARKERS: Array<{ re: RegExp; reason: string }> = [
  { re: /just a moment\.\.\./i, reason: "Blocked: Cloudflare challenge" },
  { re: /attention required/i, reason: "Blocked: Cloudflare challenge" },
  { re: /__cf_chl|cf-chl/i, reason: "Blocked: Cloudflare challenge" },
  { re: /bm-verify|akamai-bm|_abck/i, reason: "Blocked: Akamai challenge" },
  { re: /captcha-delivery\.com|ddjskey/i, reason: "Blocked: DataDome challenge" },
  { re: /px-captcha|_pxhd|px-cloud\.net|perimeterx\.net/i, reason: "Blocked: PerimeterX challenge" },
  { re: /incapsula|_incap_/i, reason: "Blocked: Imperva challenge" },
  { re: /hcaptcha\.com|h-captcha/i, reason: "Blocked: hCaptcha challenge" },
  { re: /google\.com\/recaptcha|g-recaptcha|grecaptcha/i, reason: "Blocked: reCAPTCHA challenge" },
  { re: /challenges\.cloudflare\.com\/turnstile|cf-turnstile/i, reason: "Blocked: Turnstile challenge" },
];

const INTERSTITIALS: Array<{ re: RegExp; reason: string }> = [
  { re: /verify you are human/i, reason: "Blocked: human verification challenge" },
  { re: /enable javascript and cookies/i, reason: "Blocked: JavaScript and cookies challenge" },
];

function headerValue(headers: Record<string, string>, name: string): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return "";
}

function prominent(raw: string, text: string, phrase: RegExp): boolean {
  if (text.trim().length < 1500) return true;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "";
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(raw)?.[1] ?? "";
  return phrase.test(title) || phrase.test(heading);
}

/**
 * Return a block reason, or null when the body can be shown as content.
 * The reason never includes the page body.
 *
 * A marker string alone is not enough: a real article can carry a captcha
 * widget, example code, or prose that mentions a vendor. A marker blocks only
 * when something corroborates it — a challenge status, the `cf-mitigated`
 * header, or the phrase being prominent (short page, or in the title/h1).
 */
export function blockReason(page: PageSignals): string | null {
  const mitigated = headerValue(page.headers, "cf-mitigated").toLowerCase().includes("challenge");
  if (mitigated) return "Blocked: Cloudflare challenge";

  const challengeStatus = page.status === 401 || page.status === 403 || page.status === 429 || page.status === 503;

  for (const marker of MARKERS) {
    if (!marker.re.test(page.raw)) continue;
    if (challengeStatus || prominent(page.raw, page.text, marker.re)) return marker.reason;
  }

  for (const phrase of INTERSTITIALS) {
    if (phrase.re.test(page.raw) && (challengeStatus || prominent(page.raw, page.text, phrase.re))) {
      return phrase.reason;
    }
  }

  const html = page.contentType.includes("html") || /<\w[\s\S]*>/.test(page.raw);
  const visible = page.text.trim();
  if (html && /<input\b[^>]*type\s*=\s*["']?password\b/i.test(page.raw) && /log\s*in|sign\s*in/i.test(visible) && visible.length < 800) {
    return "Blocked: login wall";
  }

  const mount = /<noscript\b/i.test(page.raw) || /id\s*=\s*["'](?:root|app|__next|__nuxt)["']/i.test(page.raw);
  if (html && visible.length < 200 && page.raw.length >= 2000 && mount) {
    return "empty or script-rendered page";
  }

  return null;
}
