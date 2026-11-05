/**
 * Redact query values whose names carry credentials.
 * The key spellings stay so a log still shows which parameter was removed.
 */

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "key",
  "secret",
  "password",
  "sig",
  "auth",
  "api_key",
  "access_token",
]);

function canonicalKey(raw: string): string {
  let key = raw;
  try {
    key = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    key = raw;
  }
  return key.trim().toLowerCase().replace(/-/g, "_");
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
    if (!SENSITIVE_QUERY_KEYS.has(canonicalKey(rawKey))) return part;
    return `${rawKey}=[REDACTED]`;
  });
  return `?${parts.join("&")}`;
}

/** Host, path, and query for a confirmation prompt. Null when the URL is not http(s). */
export function displayFetchUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.protocol}//${url.host}${url.pathname}${redactSensitiveQuery(url.search)}`;
}

/** Redact sensitive query values inside any http(s) URL in a log string. */
export function redactUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'`]+/gi, (match) => {
    const trimmed = match.replace(/[),.;]+$/g, "");
    const suffix = match.slice(trimmed.length);
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return match;
    }
    const query = redactSensitiveQuery(url.search);
    if (query === url.search) return match;
    return `${url.protocol}//${url.host}${url.pathname}${query}${url.hash}${suffix}`;
  });
}
