/**
 * Compact HTML to readable markdown. Not a general browser.
 * Drops scripts, styles, navigation, footers, and cookie/consent chrome.
 *
 * One linear pass with explicit index advancement: every byte of the input
 * is consumed at most once, so adversarial unterminated tags or comments
 * cannot cause quadratic work. Raw-text elements (script/style) consume
 * through their literal closing tag instead of nesting depth counting.
 */

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "nav",
  "footer",
  "head",
  "svg",
  "iframe",
  "template",
]);

/** HTML void elements: never have a closing tag. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text: consume to the literal closing tag. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return full;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return full;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? full;
  });
}

/**
 * Parse an open tag's attributes into (lowercased name, decoded value) pairs.
 * Respects quoted values, so a quoted `data-href="..."` never matches a
 * request for `href`, and `data-class` never matches `class`.
 */
function parseAttributes(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([a-zA-Z_:@][\w:.@-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    out.push([name, decodeEntities(value)]);
  }
  return out;
}

function attrOf(attrs: Array<[string, string]>, name: string): string | undefined {
  for (const [key, value] of attrs) {
    if (key === name) return value;
  }
  return undefined;
}

function isChrome(attrs: Array<[string, string]>): boolean {
  const id = attrOf(attrs, "id") ?? "";
  const cls = attrOf(attrs, "class") ?? "";
  const role = (attrOf(attrs, "role") ?? "").toLowerCase();
  if (role === "navigation" || role === "contentinfo") return true;
  return /cookie|consent|gdpr/i.test(`${id} ${cls}`);
}

function resolveHref(href: string, baseUrl?: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^javascript:/i.test(trimmed)) return null;
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

/** Find the end of a tag starting at `<`; returns -1 when unterminated. */
function tagEnd(html: string, from: number): number {
  for (let i = from + 1; i < html.length; i += 1) {
    if (html[i] === ">") return i;
    if (html[i] === '"') {
      const close = html.indexOf('"', i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (html[i] === "'") {
      const close = html.indexOf("'", i + 1);
      if (close === -1) return -1;
      i = close;
    }
  }
  return -1;
}

/** Find the end of a comment starting at `<!--`; -1 when unterminated. */
function commentEnd(html: string, from: number): number {
  const close = html.indexOf("-->", from + 4);
  return close === -1 ? -1 : close + 3;
}

/**
 * Literal closing-tag scan for raw-text elements. -1 when unterminated.
 *
 * Scans for the anchor `</` and compares the tag name ASCII-case-
 * insensitively. Every anchor is skipped once (search advances past it), so
 * the whole scan is linear. Earlier versions searched with a lowercased copy
 * of the document (`html.toLowerCase()`) inside the loop, which copied the
 * entire input once per false prefix match — or once per raw-text element —
 * and let adversarial input freeze the event loop for minutes.
 */
function rawTextEnd(html: string, from: number, tag: string): number {
  /** ASCII lowercase of a code unit; other values pass through. */
  const lower = (code: number): number => (code >= 65 && code <= 90 ? code + 32 : code);
  const tagLen = tag.length;
  let search = from;
  for (;;) {
    const at = html.indexOf("</", search);
    if (at === -1) return -1;
    const nameAt = at + 2;
    let matches = true;
    for (let i = 0; i < tagLen; i += 1) {
      // charCodeAt past the end is NaN, which never equals a tag code.
      if (lower(html.charCodeAt(nameAt + i)) !== tag.charCodeAt(i)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const after = html[nameAt + tagLen];
      if (after === undefined || after === ">" || after === "/" || /\s/.test(after)) {
        return at;
      }
    }
    search = at + 2;
  }
}

interface TagToken {
  token: string;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Array<[string, string]>;
}

type ScanKind = "text" | "skip" | "tag";

/**
 * Scan the next token at `from`. Returns the kind, an optional tag token, and
 * the index just past it. Unterminated tags/comments consume the rest of the
 * input once. Every path advances the index, so the scan is linear.
 */
function nextToken(html: string, from: number): { kind: ScanKind; token: TagToken | null; next: number } | null {
  if (from >= html.length) return null;
  if (html[from] !== "<") {
    const next = html.indexOf("<", from);
    return { kind: "text", token: null, next: next === -1 ? html.length : next };
  }

  if (html.startsWith("<!--", from)) {
    const end = commentEnd(html, from);
    return { kind: "skip", token: null, next: end === -1 ? html.length : end };
  }

  // Declaration or bogus comment (doctype, CDATA, <?php …): consume to '>' once.
  if (html[from + 1] === "!" || html[from + 1] === "?") {
    const end = tagEnd(html, from);
    return { kind: "skip", token: null, next: end === -1 ? html.length : end + 1 };
  }

  const nameMatch = /^<\/?([a-zA-Z][\w:-]*)/.exec(html.slice(from));
  if (!nameMatch) {
    // Not a tag (e.g. a stray `<` followed by text): consume one char so we advance.
    return { kind: "text", token: null, next: from + 1 };
  }

  const end = tagEnd(html, from);
  if (end === -1) {
    // Unterminated tag: consume the rest of the input once.
    return { kind: "skip", token: null, next: html.length };
  }
  const token = html.slice(from, end + 1);
  const name = nameMatch[1].toLowerCase();
  const closing = token.startsWith("</");
  const selfClosing = token.endsWith("/>") || VOID_TAGS.has(name);
  const attrs = closing ? [] : parseAttributes(token);
  return { kind: "tag", token: { token, name, closing, selfClosing, attrs }, next: end + 1 };
}

/**
 * Convert an HTML document to markdown. `baseUrl` resolves relative links.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  const lists: Array<{ kind: "ul" | "ol"; n: number }> = [];
  const linkStack: Array<string | null> = [];
  let out = "";
  let pre = 0;
  let inCell = false;
  let cell = "";
  let row: string[] = [];
  let rowHeader = false;
  let tableHeaderDone = false;

  const write = (text: string) => {
    if (inCell) cell += text;
    else out += text;
  };

  const addText = (raw: string) => {
    const decoded = decodeEntities(raw);
    const text = pre > 0 ? decoded : decoded.replace(/\s+/g, " ");
    if (text) write(text);
  };

  let i = 0;
  while (i < html.length) {
    const scanned = nextToken(html, i);
    if (!scanned) break;
    if (scanned.kind === "text") {
      if (i !== scanned.next) addText(html.slice(i, scanned.next));
      i = scanned.next;
      continue;
    }
    if (scanned.kind === "skip") {
      i = scanned.next;
      continue;
    }
    const { token, name, closing, selfClosing, attrs } = scanned.token!;
    i = scanned.next;

    // Raw-text elements: consume through the literal closing tag.
    if (!closing && RAW_TEXT_TAGS.has(name)) {
      const closeAt = rawTextEnd(html, i, name);
      if (closeAt === -1) {
        i = html.length;
      } else {
        const tagEndAfter = tagEnd(html, closeAt);
        i = tagEndAfter === -1 ? html.length : tagEndAfter + 1;
      }
      continue;
    }

    if (!closing && (SKIP_TAGS.has(name) || isChrome(attrs))) {
      // Nested same-name elements are skipped by depth counting; void/self-closing tags never open a frame.
      if (selfClosing) continue;
      let depth = 1;
      let scan = i;
      while (scan < html.length && depth > 0) {
        const inner = nextToken(html, scan);
        if (!inner) break;
        if (inner.kind === "tag" && inner.token !== null) {
          const innerName = inner.token.name;
          if (innerName === name && !inner.token.selfClosing) {
            depth += inner.token.closing ? -1 : 1;
          }
        }
        scan = inner.next;
      }
      i = scan;
      continue;
    }

    if (name === "h1" || name === "h2" || name === "h3" || name === "h4" || name === "h5" || name === "h6") {
      if (!closing) write(`\n\n${"#".repeat(Number(name[1]))} `);
      else write("\n\n");
      continue;
    }
    if (name === "p" || name === "div" || name === "section" || name === "article" || name === "blockquote") {
      write("\n\n");
      continue;
    }
    if (name === "br") {
      write("\n");
      continue;
    }
    if (name === "li" && !closing) {
      const list = lists[lists.length - 1];
      if (list?.kind === "ol") {
        list.n += 1;
        write(`\n${list.n}. `);
      } else {
        write("\n- ");
      }
      continue;
    }
    if ((name === "ul" || name === "ol") && !closing) {
      lists.push({ kind: name, n: 0 });
      write("\n");
      continue;
    }
    if ((name === "ul" || name === "ol") && closing) {
      lists.pop();
      write("\n\n");
      continue;
    }
    if (name === "pre") {
      if (!closing) {
        pre += 1;
        write("\n```\n");
      } else {
        pre = Math.max(0, pre - 1);
        write("\n```\n");
      }
      continue;
    }
    if (name === "code" && pre === 0) {
      write("`");
      continue;
    }
    if (name === "a") {
      if (!closing) {
        const href = resolveHref(attrOf(attrs, "href") ?? "", baseUrl);
        linkStack.push(href);
        if (href) write("[");
      } else {
        const href = linkStack.pop();
        if (href) write(`](${href})`);
      }
      continue;
    }
    if (name === "table") {
      if (!closing) {
        tableHeaderDone = false;
        write("\n");
      } else {
        write("\n\n");
      }
      continue;
    }
    if (name === "tr") {
      if (!closing) {
        row = [];
        rowHeader = false;
      } else if (row.length > 0) {
        write(`\n| ${row.join(" | ")} |`);
        if (rowHeader && !tableHeaderDone) {
          write(`\n| ${row.map(() => "---").join(" | ")} |`);
          tableHeaderDone = true;
        }
        row = [];
      }
      continue;
    }
    if (name === "th" || name === "td") {
      if (!closing) {
        inCell = true;
        cell = "";
        if (name === "th") rowHeader = true;
      } else {
        row.push(cell.trim());
        cell = "";
        inCell = false;
      }
      continue;
    }
    if (name === "img" && !closing) {
      const alt = attrOf(attrs, "alt");
      if (alt) addText(alt);
    }
  }

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
