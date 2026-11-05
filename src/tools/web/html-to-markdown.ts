/**
 * Compact HTML to readable markdown. Not a general browser.
 * Drops scripts, styles, navigation, footers, and cookie/consent chrome.
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

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

interface SkipFrame {
  tag: string;
  depth: number;
}

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

function attr(raw: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i").exec(raw);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function isChrome(raw: string): boolean {
  const id = attr(raw, "id") ?? "";
  const cls = attr(raw, "class") ?? "";
  const role = (attr(raw, "role") ?? "").toLowerCase();
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

/**
 * Convert an HTML document to markdown. `baseUrl` resolves relative links.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  const skip: SkipFrame[] = [];
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

  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)\b[^>]*>|[^<]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    if (!token.startsWith("<")) {
      if (skip.length === 0) addText(token);
      continue;
    }

    const name = (match[1] ?? "").toLowerCase();
    const closing = token.startsWith("</");
    const selfClosing = token.endsWith("/>") || name === "br" || name === "img" || name === "meta" || name === "hr";

    if (skip.length > 0) {
      const top = skip[skip.length - 1];
      if (top && name === top.tag) {
        if (closing) {
          top.depth -= 1;
          if (top.depth <= 0) skip.pop();
        } else if (!selfClosing) {
          top.depth += 1;
        }
      }
      continue;
    }

    if (!closing && (SKIP_TAGS.has(name) || isChrome(token))) {
      if (!selfClosing) skip.push({ tag: name, depth: 1 });
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
        const href = resolveHref(attr(token, "href") ?? "", baseUrl);
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
      const alt = attr(token, "alt");
      if (alt) addText(alt);
    }
  }

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
