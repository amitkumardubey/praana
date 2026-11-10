/**
 * Redact query and fragment values whose names carry credentials, plus any
 * userinfo password. The key spellings stay so a log still shows which
 * parameter was removed; fragment pairs can sit behind an SPA route prefix
 * (`#/cb?token=...`), and legacy http(s) URLs can carry a userinfo password.
 */

/** Exact canonical key names that carry a credential. */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "sig",
  "auth",
  "api_key",
  "apikey",
  "access_token",
  "session_token",
  "id_token",
  "refresh_token",
  "client_secret",
  "clientsecret",
  "private_key",
  "secret_key",
  "access_key",
  "signature",
  "x_amz_signature",
  "x_amz_credential",
  "x_amz_security_token",
]);

/**
 * Suffixes that mark a credential wherever they appear at the end of a name,
 * so `session_token`, `my_app_secret`, `db_password` are all covered without
 * listing every spelling. Over-matching only redacts more, which is safe.
 */
const SENSITIVE_SUFFIXES = ["token", "secret", "password", "passwd", "signature", "apikey", "credential"];

/** Prefixes reserved for signed cloud requests (AWS SigV4 and friends). */
const SENSITIVE_PREFIXES = ["x_amz_", "x_goog_"];

/**
 * Reduce a pair key to its final segment by dropping anything through the
 * last `?` or `/`, so `/cb?token` -> `token`. Query and fragment keys can
 * carry an SPA route prefix before the parameter name.
 */
function keySegment(rawKey: string): string {
  const cut = Math.max(rawKey.lastIndexOf("/"), rawKey.lastIndexOf("?"));
  return cut === -1 ? rawKey : rawKey.slice(cut + 1);
}

function canonicalKey(raw: string): string {
  let key = raw;
  try {
    key = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    key = raw;
  }
  // The URL parser removes tab, CR, and LF from a URL, so `?to\tken=` becomes
  // `?token=`. Strip the same characters here or a crafted key slips past.
  key = key.replace(/[\t\r\n]/g, "");
  return key.trim().toLowerCase().replace(/-/g, "_");
}

function isSensitiveKey(canonical: string): boolean {
  if (!canonical) return false;
  if (SENSITIVE_QUERY_KEYS.has(canonical)) return true;
  if (SENSITIVE_PREFIXES.some((prefix) => canonical.startsWith(prefix))) return true;
  return SENSITIVE_SUFFIXES.some(
    (suffix) => canonical === suffix || canonical.endsWith(`_${suffix}`),
  );
}

/** Redact one `key=value` pair, keeping non-sensitive parts as-is. */
function redactPair(part: string): string {
  if (!part) return part;
  const eq = part.indexOf("=");
  if (eq === -1) return part;
  const rawKey = part.slice(0, eq);
  if (!isSensitiveKey(canonicalKey(keySegment(rawKey)))) return part;
  return `${rawKey}=[REDACTED]`;
}

/**
 * Redact sensitive pairs (`key=value`) in a query string (with or without the
 * leading "?") or a URL fragment (with or without the leading "#"). Pairs are
 * separated by either `&` or `;`, and the original separators are preserved so
 * a `;` never becomes an `&`. Returns the redacted text, or the input
 * unchanged when no pair is sensitive.
 */
function redactPairs(raw: string, prefix: string): string | null {
  const body = raw.startsWith(prefix) ? raw.slice(1) : raw;
  const pieces = body.split(/([&;])/);
  const parts: string[] = [];
  for (let index = 0; index < pieces.length; index += 2) {
    parts.push(redactPair(pieces[index]));
    if (index + 1 < pieces.length) parts.push(pieces[index + 1]);
  }
  const joined = parts.join("");
  if (joined === body) return null;
  const redacted = raw.startsWith(prefix) ? `${prefix}${joined}` : joined;
  return redacted;
}

/** Rewrite one query string (with or without the leading "?"). */
export function redactSensitiveQuery(search: string): string {
  if (!search || search === "?") return "";
  const redacted = redactPairs(search, "?");
  return redacted ?? search;
}

/** Redact credential-bearing pairs from a URL fragment (with or without the leading "#"). */
export function redactSensitiveFragment(hash: string): string {
  if (!hash) return hash;
  const redacted = redactPairs(hash, "#");
  return redacted ?? hash;
}

/** True when a query string (or fragment) has at least one credential-bearing key. */
function hasSensitivePair(raw: string, prefix: string): boolean {
  const body = raw.startsWith(prefix) ? raw.slice(1) : raw;
  if (!body) return false;
  for (const part of body.split(/[&;]/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (isSensitiveKey(canonicalKey(keySegment(part.slice(0, eq))))) return true;
  }
  return false;
}

/** True when a query string (or fragment) has at least one credential-bearing key. */
function hasSensitiveQuery(search: string, hash: string): boolean {
  return hasSensitivePair(search, "?") || hasSensitivePair(hash, "#");
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Host (with port) for a parsed URL, replacing a userinfo password with
 * `[REDACTED]`. A bare username has no colon and is left alone.
 */
function redactedAuthority(url: URL): { authority: string; changed: boolean } {
  if (!url.password) return { authority: url.host, changed: false };
  return {
    authority: `${url.username}:[REDACTED]@${url.host}`,
    changed: true,
  };
}

function shown(url: URL): string {
  return `${url.protocol}//${redactedAuthority(url).authority}${url.pathname}${redactSensitiveQuery(url.search)}${redactSensitiveFragment(url.hash)}`;
}

/** Host, path, query, and fragment for a confirmation prompt. Null when the URL is not http(s). */
export function displayFetchUrl(raw: string): string | null {
  const url = parseHttpUrl(raw);
  return url ? shown(url) : null;
}

/**
 * Redact sensitive query and fragment values, and any userinfo password, inside
 * any http(s) URL in a log string. A userinfo password
 * (`user:pw@host` -> `user:[REDACTED]@host`) is redacted even when it is the
 * URL's only credential; a bare username without a colon stays unchanged.
 *
 * Trailing sentence punctuation is only stripped when the URL carries no
 * credential parameter. If it does, the untrimmed match is redacted whole so
 * punctuation that belongs to the value (`?password=abc);`) is removed with
 * it rather than restored to the log.
 */
export function redactUrlsInText(text: string): string {
  // Allow a tab inside the match (the URL parser strips it); a space or a
  // newline still ends the URL.
  return text.replace(/https?:\/\/[^ \n\r\f\v<>"'`]+/gi, (match) => {
    const untrimmed = parseHttpUrl(match);
    if (untrimmed && (hasSensitiveQuery(untrimmed.search, untrimmed.hash) || Boolean(untrimmed.password))) {
      return shown(untrimmed);
    }

    const trimmed = match.replace(/[),.;]+$/g, "");
    const suffix = match.slice(trimmed.length);
    const url = parseHttpUrl(trimmed);
    if (!url) return match;
    const query = redactSensitiveQuery(url.search);
    const fragment = redactSensitiveFragment(url.hash);
    const { authority, changed } = redactedAuthority(url);
    if (query === url.search && fragment === url.hash && !changed) return match;
    return `${url.protocol}//${authority}${url.pathname}${query}${fragment}${suffix}`;
  });
}
