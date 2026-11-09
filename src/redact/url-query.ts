/**
 * Redact query values whose names carry credentials.
 * The key spellings stay so a log still shows which parameter was removed.
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

/** Rewrite one query string (with or without the leading "?"). */
export function redactSensitiveQuery(search: string): string {
  if (!search || search === "?") return "";
  const body = search.startsWith("?") ? search.slice(1) : search;
  const parts = body.split("&").map((part) => {
    if (!part) return part;
    const eq = part.indexOf("=");
    if (eq === -1) return part;
    const rawKey = part.slice(0, eq);
    if (!isSensitiveKey(canonicalKey(rawKey))) return part;
    return `${rawKey}=[REDACTED]`;
  });
  return `?${parts.join("&")}`;
}

/** True when the query string has at least one credential-bearing key. */
function hasSensitiveQuery(search: string): boolean {
  if (!search || search === "?") return false;
  const body = search.startsWith("?") ? search.slice(1) : search;
  for (const part of body.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (isSensitiveKey(canonicalKey(part.slice(0, eq)))) return true;
  }
  return false;
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

function shown(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}${redactSensitiveQuery(url.search)}${url.hash}`;
}

/** Host, path, and query for a confirmation prompt. Null when the URL is not http(s). */
export function displayFetchUrl(raw: string): string | null {
  const url = parseHttpUrl(raw);
  return url ? shown(url) : null;
}

/**
 * Redact sensitive query values inside any http(s) URL in a log string.
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
    if (untrimmed && hasSensitiveQuery(untrimmed.search)) return shown(untrimmed);

    const trimmed = match.replace(/[),.;]+$/g, "");
    const suffix = match.slice(trimmed.length);
    const url = parseHttpUrl(trimmed);
    if (!url) return match;
    const query = redactSensitiveQuery(url.search);
    if (query === url.search) return match;
    return `${url.protocol}//${url.host}${url.pathname}${query}${url.hash}${suffix}`;
  });
}
