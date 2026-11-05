/**
 * SSRF guard for web_fetch.
 *
 * DNS is resolved once per hop and every A/AAAA answer is checked. The HTTP
 * client then connects with `createPinnedLookup`, which returns that same
 * address and does not query DNS again. A later resolver answer cannot move
 * the socket onto a private address (DNS rebinding).
 *
 * There is no config or environment switch that turns this off. Tests inject
 * `lookup` / `transport`; production uses the system resolver.
 */

import { lookup, resolve4, resolve6 } from "node:dns/promises";

export const MAX_REDIRECTS = 5;

export interface HostAddress {
  address: string;
  family: 4 | 6;
}

export interface HostLookup {
  resolve(hostname: string): Promise<HostAddress[]>;
}

export interface GuardPin {
  url: URL;
  address: string;
  family: 4 | 6;
  /** Returns `address` and does not query DNS. Pass this to `node:http` / `node:https`. */
  lookup: PinnedLookup;
}

export type GuardResult = { ok: true; pin: GuardPin } | { ok: false; reason: string };

export interface GuardedExchange {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface GuardTransport {
  exchange(pin: GuardPin): Promise<GuardedExchange>;
}

export type FetchGuardedResult =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
      finalUrl: string;
      address: string;
    }
  | { ok: false; reason: string };

/** Node-style lookup. `options.all` is what Bun's HTTP client passes. */
export type PinnedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void;

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function ipv4ToInt(a: number, b: number, c: number, d: number): number {
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

function dotted(ip: number): string {
  return `${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`;
}

/** inet_aton forms: decimal, hex (0x), octal (leading 0), and 1–4 part shorts. */
function parseLegacyIpv4(input: string): number | null {
  if (!/^[0-9a-fx.]+$/i.test(input)) return null;
  const parts = input.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part, 8);
    else if (/^(?:0|[1-9]\d*)$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    nums.push(value);
  }
  const lastMax = [0xffffffff, 0xffffff, 0xffff, 0xff][nums.length - 1] ?? 0;
  const last = nums[nums.length - 1] ?? 0;
  if (last > lastMax) return null;
  for (let i = 0; i < nums.length - 1; i++) {
    if ((nums[i] ?? 0) > 255) return null;
  }
  if (nums.length === 1) return last >>> 0;
  if (nums.length === 2) {
    const rest = nums[1] ?? 0;
    return ipv4ToInt(nums[0] ?? 0, (rest >>> 16) & 255, (rest >>> 8) & 255, rest & 255);
  }
  if (nums.length === 3) {
    const rest = nums[2] ?? 0;
    return ipv4ToInt(nums[0] ?? 0, nums[1] ?? 0, (rest >>> 8) & 255, rest & 255);
  }
  return ipv4ToInt(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0);
}

function ipv4Kind(ip: number): string | null {
  const a = (ip >>> 24) & 255;
  const b = (ip >>> 16) & 255;
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return null;
}

function parseIpv6(input: string): bigint | null {
  let text = input;
  if (text.includes(".")) {
    const last = text.lastIndexOf(":");
    if (last < 0) return null;
    const v4 = parseLegacyIpv4(text.slice(last + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, last)}:${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (head.length + tail.length > 7) {
    return null;
  }
  const missing = halves.length === 2 ? 8 - (head.length + tail.length) : 0;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out = (out << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return out;
}

type ParsedIp =
  | { family: 4; address: string; ipv4: number }
  | { family: 6; address: string; ipv6: bigint };

function parseIp(host: string): ParsedIp | null {
  if (host.includes(":")) {
    const ipv6 = parseIpv6(host);
    if (ipv6 === null) return null;
    return { family: 6, address: host, ipv6 };
  }
  const ipv4 = parseLegacyIpv4(host);
  if (ipv4 === null) return null;
  return { family: 4, address: dotted(ipv4), ipv4 };
}

function ipv6Kind(ip: bigint): string | null {
  if (ip === 1n) return "loopback";
  if (ip === 0n) return "unspecified";
  const high96 = ip >> 32n;
  const embedded = Number(ip & 0xffffffffn);
  if (high96 === 0xffffn) return ipv4Kind(embedded);
  if (high96 === 0n) return ipv4Kind(embedded);
  const top16 = Number((ip >> 112n) & 0xffffn);
  if (top16 === 0x2002) return ipv4Kind(Number((ip >> 80n) & 0xffffffffn));
  if (high96 === 0x0064ff9b0000000000000000n) return ipv4Kind(embedded);
  const top8 = Number((ip >> 120n) & 0xffn);
  if (top8 === 0xff) return "multicast";
  const top7 = Number((ip >> 121n) & 0x7fn);
  if (top7 === 0x7e) return "private";
  const top10 = Number((ip >> 118n) & 0x3ffn);
  if (top10 === 0x3fa) return "link-local";
  if (top10 === 0x3fb) return "private";
  return null;
}

/**
 * Classify one address. Returns a block reason (`loopback`, `private`, …)
 * or null when the address is a public IP. Non-IP strings return null.
 */
export function classifyAddress(input: string): string | null {
  const parsed = parseIp(stripHost(input));
  if (!parsed) return null;
  if (parsed.family === 4) return ipv4Kind(parsed.ipv4);
  return ipv6Kind(parsed.ipv6);
}

function blockedName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    host === "internal" ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  );
}

async function systemResolve(hostname: string): Promise<HostAddress[]> {
  const found = new Map<string, HostAddress>();
  const add = (address: string, family: 4 | 6) => {
    found.set(`${family}:${address}`, { address, family });
  };

  let lookupError: string | null = null;
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    for (const rec of records) add(rec.address, rec.family === 6 ? 6 : 4);
  } catch (err) {
    const code = errorCode(err);
    if (!code || !NO_RECORD.has(code)) lookupError = errorMessage(err);
  }

  const v4 = await readRecords(hostname, 4);
  const v6 = await readRecords(hostname, 6);
  if (v4.kind === "records") for (const address of v4.records) add(address, 4);
  if (v6.kind === "records") for (const address of v6.records) add(address, 6);
  const hard = v4.kind === "error" ? v4 : v6.kind === "error" ? v6 : null;
  if (hard && hard.kind === "error") {
    throw new Error(`DNS lookup failed: ${hard.message}`);
  }
  if (found.size === 0) {
    throw new Error(lookupError ? `DNS lookup failed: ${lookupError}` : "DNS lookup returned no addresses");
  }
  return [...found.values()];
}

async function readRecords(
  hostname: string,
  family: 4 | 6,
): Promise<{ kind: "records"; records: string[] } | { kind: "none" } | { kind: "error"; message: string }> {
  try {
    const records = family === 4 ? await resolve4(hostname) : await resolve6(hostname);
    return { kind: "records", records };
  } catch (err) {
    const code = errorCode(err);
    if (code && NO_RECORD.has(code)) return { kind: "none" };
    return { kind: "error", message: errorMessage(err) };
  }
}

function parseHttpUrl(input: string | URL): URL | { ok: false; reason: string } {
  try {
    const url = typeof input === "string" ? new URL(input) : new URL(input.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: "only http and https URLs are allowed" };
    }
    if (url.username !== "" || url.password !== "") {
      return { ok: false, reason: "URL userinfo is not allowed" };
    }
    if (!stripHost(url.hostname)) return { ok: false, reason: "invalid URL" };
    return url;
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
}

export async function guardUrl(input: string | URL, deps?: { lookup?: HostLookup }): Promise<GuardResult> {
  const parsed = parseHttpUrl(input);
  if (!(parsed instanceof URL)) return parsed;
  const host = stripHost(parsed.hostname);
  const ip = parseIp(host);
  if (ip) {
    const kind = ip.family === 4 ? ipv4Kind(ip.ipv4) : ipv6Kind(ip.ipv6);
    if (kind) return { ok: false, reason: `blocked address ${ip.address} (${kind})` };
    return { ok: true, pin: makePin(parsed, ip.address, ip.family) };
  }
  if (blockedName(host)) return { ok: false, reason: `blocked hostname ${host}` };

  const resolve = deps?.lookup?.resolve.bind(deps.lookup) ?? systemResolve;
  let records: HostAddress[];
  try {
    records = await resolve(host);
  } catch (err) {
    const message = errorMessage(err);
    return { ok: false, reason: message.toLowerCase().includes("dns") ? message : `DNS lookup failed: ${message}` };
  }
  if (records.length === 0) return { ok: false, reason: "DNS lookup returned no addresses" };

  let pin: HostAddress | null = null;
  for (const rec of records) {
    const kind = classifyAddress(rec.address);
    const parsedRec = parseIp(stripHost(rec.address));
    if (!parsedRec) {
      return { ok: false, reason: `DNS lookup returned an unusable address ${rec.address}` };
    }
    if (kind) {
      return { ok: false, reason: `hostname resolved to a blocked address ${rec.address} (${kind})` };
    }
    if (!pin) pin = { address: rec.address, family: parsedRec.family };
  }
  if (!pin) return { ok: false, reason: "DNS lookup returned no addresses" };
  return { ok: true, pin: makePin(parsed, pin.address, pin.family) };
}

function makePin(url: URL, address: string, family: 4 | 6): GuardPin {
  return { url, address, family, lookup: createPinnedLookup({ address, family }) };
}

export function assessRedirect(
  from: URL,
  location: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let next: URL;
  try {
    next = new URL(location.trim(), from);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    return { ok: false, reason: "redirect scheme must stay http or https" };
  }
  if (from.protocol === "https:" && next.protocol === "http:") {
    return { ok: false, reason: "https to http downgrade refused" };
  }
  if (next.username !== "" || next.password !== "") {
    return { ok: false, reason: "redirect URL contains userinfo" };
  }
  return { ok: true, url: next };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

export async function fetchGuarded(
  input: string,
  deps: { lookup?: HostLookup; transport: GuardTransport; maxRedirects?: number },
): Promise<FetchGuardedResult> {
  const initial = parseHttpUrl(input);
  if (!(initial instanceof URL)) return initial;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  let current = initial;
  let followed = 0;
  for (;;) {
    const guarded = await guardUrl(current, { lookup: deps.lookup });
    if (!guarded.ok) return guarded;
    const res = await deps.transport.exchange(guarded.pin);
    const location = header(res.headers, "location");
    if (!REDIRECT_STATUS.has(res.status) || location === undefined) {
      return {
        ok: true,
        status: res.status,
        headers: res.headers,
        body: res.body,
        finalUrl: guarded.pin.url.href,
        address: guarded.pin.address,
      };
    }
    if (followed >= maxRedirects) return { ok: false, reason: "too many redirects" };
    const next = assessRedirect(guarded.pin.url, location);
    if (!next.ok) return next;
    current = next.url;
    followed += 1;
  }
}

export function createPinnedLookup(pin: { address: string; family: 4 | 6 }): PinnedLookup {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pin.address, family: pin.family }]);
      return;
    }
    callback(null, pin.address, pin.family);
  };
}
