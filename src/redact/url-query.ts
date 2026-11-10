/**
 * Redact query and fragment values whose names carry credentials, plus any
 * userinfo credential. The key spellings stay so a log still shows which
 * parameter was removed; fragment pairs can sit behind an SPA route prefix
 * (`#/cb?token=...`), and legacy http(s) URLs can carry a userinfo username
 * or password.
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
 * Percent-decode a raw pair key the same way the URL parser would, so an
 * encoded SPA-route separator (`%2F` `/`, `%3F` `?`, `%3B` `;`, `%21` `!`)
 * cannot hide the parameter name. Malformed escapes are kept as-is.
 */
function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/**
 * Reduce a decoded pair key to its final segment by dropping anything through
 * the last `/`, `?`, `;` or `!`, so `/cb?token` -> `token` and `!token` ->
 * `token`. Query and fragment keys can carry an SPA route prefix before the
 * parameter name.
 */
function keySegment(decodedKey: string): string {
  const cut = Math.max(
    decodedKey.lastIndexOf("/"),
    decodedKey.lastIndexOf("?"),
    decodedKey.lastIndexOf(";"),
    decodedKey.lastIndexOf("!"),
  );
  return cut === -1 ? decodedKey : decodedKey.slice(cut + 1);
}

/**
 * Normalize a decoded key the way the URL parser would: strip the control
 * characters it removes from URLs, then fold case and hyphen form.
 */
function canonicalKey(decoded: string): string {
  // The URL parser removes tab, CR, and LF from a URL, so `?to\tken=` becomes
  // `?token=`. Strip the same characters here or a crafted key slips past.
  const key = decoded.replace(/[\t\r\n]/g, "");
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

/** One `;`-separated piece of an `&`-segment, with offsets into the segment. */
interface SegmentPiece {
  /** Offset of the piece within the segment. */
  start: number;
  /** Offset just past the end of the piece within the segment. */
  end: number;
  /** Index of "=" within the piece, or -1 when the piece has none. */
  eq: number;
  /** True when the piece's key carries a credential. */
  sensitive: boolean;
}

/** Scan one `&`-segment's `;`-separated pieces left to right. */
function piecesOf(segment: string): SegmentPiece[] {
  const pieces: SegmentPiece[] = [];
  let from = 0;
  while (from <= segment.length) {
    const stop = segment.indexOf(";", from);
    const end = stop === -1 ? segment.length : stop;
    const piece = segment.slice(from, end);
    const eq = piece.indexOf("=");
    pieces.push({
      start: from,
      end,
      eq,
      sensitive:
        eq !== -1 &&
        isSensitiveKey(canonicalKey(keySegment(decodeKey(piece.slice(0, eq))))),
    });
    if (stop === -1) break;
    from = stop + 1;
  }
  return pieces;
}

/**
 * Redact sensitive pairs (`key=value`) in a query string (with or without the
 * leading "?") or a URL fragment (with or without the leading "#"). The body
 * is split on `&` into segments, then each segment on `;` into pieces. When a
 * piece's key is sensitive, everything from that piece's value start through
 * the last non-empty piece is replaced with `[REDACTED]`, so later `;`-pieces
 * in the segment (which may be the tail of the value) are swallowed; original
 * `;` and `&` separators before it, and trailing separators with nothing after
 * them, are preserved. Returns the redacted text, or null when no pair is
 * sensitive.
 */
function redactPairs(raw: string, prefix: string): string | null {
  const body = raw.startsWith(prefix) ? raw.slice(1) : raw;
  if (!body) return null;
  const segments = body.split("&");
  const parts: string[] = [];
  let changed = false;
  for (let index = 0; index < segments.length; index += 1) {
    if (index > 0) parts.push("&");
    const segment = segments[index];
    const pieces = piecesOf(segment);
    const sensitiveAt = pieces.findIndex((piece) => piece.sensitive);
    if (sensitiveAt === -1) {
      parts.push(segment);
      continue;
    }
    changed = true;
    let lastNonEmptyEnd = -1;
    for (const piece of pieces) {
      if (piece.end > piece.start) lastNonEmptyEnd = piece.end;
    }
    const piece = pieces[sensitiveAt];
    const cut = piece.start + piece.eq + 1;
    parts.push(segment.slice(0, cut));
    parts.push("[REDACTED]");
    if (lastNonEmptyEnd > cut) parts.push(segment.slice(lastNonEmptyEnd));
  }
  if (!changed) return null;
  return raw.startsWith(prefix) ? `${prefix}${parts.join("")}` : parts.join("");
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
  for (const segment of body.split("&")) {
    for (const piece of piecesOf(segment)) {
      if (piece.sensitive) return true;
    }
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
 * Host (with port) for a parsed URL, replacing any userinfo credential with
 * `[REDACTED]`: a password keeps its username (`user:pw@host` ->
 * `user:[REDACTED]@host`), and a bare username (which is often itself a
 * credential, such as a GitHub personal access token or a Stripe live key)
 * becomes `[REDACTED]@host`.
 */
function redactedAuthority(url: URL): { authority: string; changed: boolean } {
  if (url.password) {
    return {
      authority: `${url.username}:[REDACTED]@${url.host}`,
      changed: true,
    };
  }
  if (url.username) {
    return { authority: `[REDACTED]@${url.host}`, changed: true };
  }
  return { authority: url.host, changed: false };
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
 * Redact sensitive query and fragment values, and any userinfo credential,
 * inside any http(s) URL in a log string. A userinfo password
 * (`user:pw@host` -> `user:[REDACTED]@host`) and a bare username
 * (`user@host` -> `[REDACTED]@host`, often a credential itself) are redacted
 * even when they are the URL's only credential.
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
