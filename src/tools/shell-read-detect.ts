export interface ShellReadDetection {
  kind: string;
  paths: string[];
}

const SIMPLE_READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
]);
const SEARCH_READERS = new Set(["rg", "grep"]);

/** True if the command is a compound / piped shell expression we refuse to parse. */
function isCompound(command: string): boolean {
  // Any unquoted pipe, &&, ||, or ; means we bail (under-count > false positive).
  return /(?: \| |&&|\|\||;)/.test(command);
}

function tokenize(command: string): string[] {
  // Simple whitespace split that keeps single/double-quoted spans intact.
  const tokens: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const raw = m[0];
    if (
      (raw.startsWith('"') && raw.endsWith('"'))
      || (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      tokens.push(raw.slice(1, -1));
    } else {
      tokens.push(raw);
    }
  }
  return tokens;
}

function stripFlags(tokens: string[], optsWithValue: Set<string>): string[] {
  const out: string[] = [];
  let i = 0;
  let endFlags = false;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (!endFlags && t === "--") {
      endFlags = true;
      i++;
      continue;
    }
    if (!endFlags && t.startsWith("-") && t !== "-") {
      const flag = t.replace(/^--?/, "").split("=")[0]!;
      // -n20 style glued values count as a single flag token (no separate value).
      if (
        optsWithValue.has(flag)
        && !t.includes("=")
        && !/^-[^-].+\d/.test(t)
      ) {
        i += 2; // skip flag + its value
        continue;
      }
      i++;
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
}

const SED_PRINT_RE = /^\d+(?:,\d+)?p$/;

/**
 * Detect read-equivalent shell commands. Returns null on ambiguity or non-reads.
 * Never throws. Pure — no I/O, no side effects.
 */
export function detectShellReads(command: string): ShellReadDetection | null {
  const trimmed = command.trim();
  if (!trimmed || isCompound(trimmed)) return null;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;

  // Drop env assignments: FOO=1 cat a.ts
  let idx = 0;
  while (
    idx < tokens.length
    && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)
  ) idx++;
  const rest = tokens.slice(idx);
  if (rest.length === 0) return null;

  // Bare name even if an absolute path to a binary.
  const bare = rest[0]!.includes("/") ? rest[0]!.split("/").pop()! : rest[0]!;

  if (SIMPLE_READERS.has(bare)) {
    const optsWithValue = bare === "head" || bare === "tail"
      ? new Set(["n", "c", "q"])
      : new Set<string>();
    const paths = stripFlags(rest.slice(1), optsWithValue).filter(
      (p) => p.length > 0,
    );
    if (paths.length === 0) return null;
    return { kind: bare, paths };
  }

  if (bare === "sed") {
    // Only sed -n <print-expr> <file>. Reject -i and non-print scripts.
    const args = rest.slice(1);
    const hasN = args.some(
      (a) => a === "-n" || a === "--quiet" || a === "--silent",
    );
    const hasI = args.some(
      (a) => a === "-i" || a.startsWith("-i") || a === "--in-place",
    );
    if (!hasN || hasI) return null;
    const positional = stripFlags(
      args,
      new Set(["e", "f", "expression", "file"]),
    );
    // positional: [script, ...files]
    if (positional.length < 2) return null;
    const script = positional[0]!;
    if (!SED_PRINT_RE.test(script)) return null;
    const paths = positional.slice(1);
    if (paths.length === 0) return null;
    return { kind: "sed", paths };
  }

  if (SEARCH_READERS.has(bare)) {
    // Last non-flag token is the path; pattern is the one before it.
    const positional = stripFlags(rest.slice(1), new Set([
      "e",
      "f",
      "g",
      "max-count",
      "m",
      "A",
      "B",
      "C",
      "context",
      "type",
      "t",
      "glob",
      "iglob",
      "max-depth",
    ]));
    if (positional.length < 2) return null; // need pattern + path
    const path = positional[positional.length - 1]!;
    return { kind: bare, paths: [path] };
  }

  return null;
}
