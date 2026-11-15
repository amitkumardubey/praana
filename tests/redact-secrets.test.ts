import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { redactSecrets, redactSecretsStrict } from "../src/redact/secrets.js";

/** Shape used by the depth matrix: a secret assignment and a bare AWS key. */
const SECRETS = [
  "ANTHROPIC_API_KEY=sk-ant-api03-" + "A".repeat(40),
  "AKIAIOSFODNN7EXAMPLE",
];
const SECRET_MARKERS = ["sk-ant-api03-", "AKIAIOSFODNN7EXAMPLE"];

/** Secrets that only expose their prefix once a `\b` boundary follows an escape. */
const ESCAPED_SECRETS = [
  "log\nAKIAIOSFODNN7EXAMPLE",
  "x\tghp_" + "a".repeat(36),
  "é sk-" + "b".repeat(24),
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  "API_KEY=" + "A1b2C3d4-E5f6G7h8I9j0K1l2",
];
const ESCAPED_MARKERS = [
  "AKIAIOSFODNN7EXAMPLE",
  "ghp_",
  "é sk-",
  "MIIEowIBAAKCAQEA",
  "A1b2C3d4-E5f6G7h8I9j0K1l2",
];

function nestObjects(value: unknown, depth: number): unknown {
  let current = value;
  for (let i = 0; i < depth; i++) current = { n: current };
  return current;
}

function nestArrays(value: unknown, depth: number): unknown {
  let current = value;
  for (let i = 0; i < depth; i++) current = [current];
  return current;
}

function nestMixed(value: unknown, depth: number): unknown {
  let current = value;
  for (let i = 0; i < depth; i++) current = i % 2 === 0 ? { n: current } : [current];
  return current;
}

const NESTERS: Array<[string, (value: unknown, depth: number) => unknown]> = [
  ["plain objects", nestObjects],
  ["arrays", nestArrays],
  ["mixed objects and arrays", nestMixed],
];

function expectNoSecret(json: string): void {
  for (const marker of SECRET_MARKERS) expect(json).not.toContain(marker);
}

function expectNoEscapedSecret(json: string): void {
  for (const marker of ESCAPED_MARKERS) expect(json).not.toContain(marker);
}

/** Follow `key` from the root, `levels` times, and return the deepest value. */
function descend(value: unknown, levels: number, key = "n"): unknown {
  let current = value;
  for (let i = 0; i < levels; i++) {
    if (current === null || typeof current !== "object") return current;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("redactSecretsStrict", () => {
  it("uses the same redaction walk", () => {
    const value = { key: "AKIAIOSFODNN7EXAMPLE" };
    expect(redactSecretsStrict(value)).toEqual(redactSecrets(value));
  });

  it("throws at the walk depth limit", () => {
    for (const depth of [8, 9, 20]) {
      let value: unknown = "AKIAIOSFODNN7EXAMPLE";
      for (let i = 0; i < depth; i++) value = { nested: value };
      expect(() => redactSecretsStrict(value)).toThrow("depth");
      // Non-strict mode now fails closed there instead of returning the subtree.
      expectNoSecret(JSON.stringify(redactSecrets(value)) ?? "");
    }
  });

  it("propagates errors rather than returning the original value", () => {
    const value = Object.defineProperty({}, "broken", {
      enumerable: true,
      get() { throw new Error("walk failed"); },
    });
    // Callers cast the result to a record, so an object input keeps a record shape.
    expect(redactSecrets(value)).toEqual({ error: "[REDACTED:redaction-error]" });
    expect(() => redactSecretsStrict(value)).toThrow("walk failed");
  });

  it("walks null-prototype objects and arrays of them in strict mode", () => {
    const token = "ghp_" + "a".repeat(36);
    const inner = Object.assign(Object.create(null), { token });
    const outer = Object.assign(Object.create(null), { nested: inner });
    const walked = redactSecretsStrict(outer) as { nested: { token: string } };
    expect(walked.nested.token).toBe("[REDACTED:github-token]");
    const listed = redactSecretsStrict([inner]) as Array<{ token: string }>;
    expect(listed[0]!.token).toBe("[REDACTED:github-token]");
  });

  it("throws a TypeError naming any object it cannot walk in strict mode", () => {
    class Custom { value = "ghp_" + "a".repeat(36); }
    const kinds: Array<[string, unknown]> = [
      ["Custom", new Custom()],
      ["Map", new Map()],
      ["Set", new Set()],
      ["Date", new Date(0)],
      ["Uint8Array", new Uint8Array(1)],
      ["function", () => "x"],
    ];
    for (const [type, value] of kinds) {
      expect(() => redactSecretsStrict(value)).toThrow(TypeError);
      expect(() => redactSecretsStrict(value)).toThrow(type);
      // Non-strict behaviour is unchanged: the value is returned as it is.
      expect(redactSecrets(value)).toBe(value);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts AWS, GitHub, GitLab, OpenAI, Anthropic", () => {
    expect(redactSecrets("id=AKIAIOSFODNN7EXAMPLE")).toBe(
      "id=[REDACTED:aws-access-key]",
    );
    expect(redactSecrets("t=ghp_" + "a".repeat(36))).toContain("[REDACTED:github-token]");
    expect(redactSecrets("t=glpat-" + "b".repeat(20))).toContain("[REDACTED:gitlab-token]");
    expect(redactSecrets("k=sk-" + "c".repeat(40))).toContain("[REDACTED:openai-key]");
    expect(redactSecrets("k=sk-ant-" + "d".repeat(40))).toContain("[REDACTED:anthropic-key]");
  });

  it("treats sk-ant- as anthropic not openai", () => {
    const out = String(redactSecrets("sk-ant-" + "e".repeat(40)));
    expect(out).toContain("anthropic-key");
    expect(out).not.toContain("openai-key");
  });

  it("redacts a PEM block as one placeholder", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[REDACTED:private-key]");
  });

  it("redacts KEY= mixed-charset values and skips SHA/ULID", () => {
    expect(redactSecrets("API_KEY=abc123XYZ-" + "f".repeat(16))).toContain(
      "[REDACTED:key-assignment]",
    );
    expect(redactSecrets("KEY=" + "a".repeat(40))).toBe("KEY=" + "a".repeat(40));
    expect(redactSecrets("TOKEN=01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(
      "TOKEN=01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
  });

  it("walks nested objects and does not flip ok", () => {
    const out = redactSecrets({
      ok: true,
      stdout: "AKIAIOSFODNN7EXAMPLE",
    }) as { ok: boolean; stdout: string };
    expect(out.ok).toBe(true);
    expect(out.stdout).toBe("[REDACTED:aws-access-key]");
  });

  it("does not walk deeper than 8 but keeps the over-limit shape", () => {
    let nested: unknown = "AKIAIOSFODNN7EXAMPLE";
    for (let i = 0; i < 9; i++) nested = { n: nested };
    const out = redactSecrets(nested);
    const atLimit = descend(out, 8);
    // The over-limit value is still an object, not a serialized string.
    expect(typeof atLimit).toBe("object");
    expect(Array.isArray(atLimit)).toBe(false);
    expect(descend(out, 9)).toBe("[REDACTED:aws-access-key]");
    expectNoSecret(JSON.stringify(out) ?? "");
  });

  it.each(NESTERS)("redacts secrets nested 1..20 deep in %s", (_shape, nest) => {
    for (let depth = 1; depth <= 20; depth++) {
      for (const secret of SECRETS) {
        const out = redactSecrets(nest(secret, depth));
        expectNoSecret(JSON.stringify(out) ?? "");
      }
    }
  });

  it.each(NESTERS)("redacts secrets behind an escape 1..20 deep in %s", (_shape, nest) => {
    for (let depth = 1; depth <= 20; depth++) {
      for (const secret of ESCAPED_SECRETS) {
        const json = JSON.stringify(redactSecrets(nest(secret, depth))) ?? "";
        expectNoSecret(json);
        expectNoEscapedSecret(json);
      }
    }
  });

  it.each([7, 8, 9, 12])("redacts an API_KEY assignment at depth %i", (depth) => {
    const json = JSON.stringify(redactSecrets(nestObjects(ESCAPED_SECRETS[4]!, depth))) ?? "";
    expect(json).not.toContain("A1b2C3d4-E5f6G7h8I9j0K1l2");
    expect(json).toContain("[REDACTED:key-assignment]");
  });

  it("keeps objects and arrays at the deep levels", () => {
    const leaf = { value: "AKIAIOSFODNN7EXAMPLE", list: ["AKIAIOSFODNN7EXAMPLE"] };
    let value: unknown = leaf;
    for (let i = 0; i < 12; i++) value = { n: value };
    const out = redactSecrets(value);
    const atLimit = descend(out, 8);
    expect(typeof atLimit).toBe("object");
    expect(Array.isArray(atLimit)).toBe(false);
    const copied = descend(out, 12) as { value: string; list: string[] };
    expect(copied.value).toBe("[REDACTED:aws-access-key]");
    expect(Array.isArray(copied.list)).toBe(true);
    expect(copied.list[0]).toBe("[REDACTED:aws-access-key]");
    // `list` stays an array, so its JSON is a list of redacted strings.
    expect(JSON.stringify(copied.list)).toBe('["[REDACTED:aws-access-key]"]');
  });

  it("replaces a revisited node with the cycle placeholder", () => {
    const cyclic: Record<string, unknown> = { secret: "AKIAIOSFODNN7EXAMPLE" };
    cyclic.self = cyclic;
    const value = { shallow: "AKIAIOSFODNN7EXAMPLE", deep: nestObjects(cyclic, 12) };
    const out = redactSecrets(value);
    const json = JSON.stringify(out) ?? "";
    expectNoSecret(json);
    expect(json).toContain("[REDACTED:cycle]");
    // The sibling secret above the limit is still walked and redacted.
    expect((out as { shallow: string }).shallow).toBe("[REDACTED:aws-access-key]");
  });

  it.each<[string, () => unknown]>([
    ["a Map", () => new Map([["k", "AKIAIOSFODNN7EXAMPLE"]])],
    ["a Set", () => new Set(["AKIAIOSFODNN7EXAMPLE"])],
    ["a class instance", () => new (class Custom { readonly token = "AKIAIOSFODNN7EXAMPLE"; })()],
    ["a Date", () => new Date(0)],
    ["a null-prototype object", () => Object.assign(Object.create(null), {
      token: "AKIAIOSFODNN7EXAMPLE",
    })],
    ["a function", () => () => "AKIAIOSFODNN7EXAMPLE"],
    ["a typed array", () => new Uint8Array(4)],
  ])("replaces %s at depth 10 with the unwalkable placeholder", (_name, build) => {
    const out = redactSecrets(nestObjects(build(), 10));
    expect(descend(out, 10)).toBe("[REDACTED:unwalkable]");
    expect(JSON.stringify(out)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("replaces only a throwing property read at depth 10", () => {
    const value = Object.defineProperty({ ok: "AKIAIOSFODNN7EXAMPLE" }, "broken", {
      enumerable: true,
      get() { throw new Error("read failed"); },
    });
    const atLimit = descend(redactSecrets(nestObjects(value, 10)), 10) as {
      ok: string;
      broken: string;
    };
    expect(atLimit.broken).toBe("[REDACTED:redaction-error]");
    // Sibling fields are still walked and redacted.
    expect(atLimit.ok).toBe("[REDACTED:aws-access-key]");
  });

  it("keeps primitives below the depth limit while redacting strings", () => {
    const out = redactSecrets(nestObjects({ secret: "AKIAIOSFODNN7EXAMPLE", count: 1n }, 12));
    const atLimit = descend(out, 12) as { secret: string; count: bigint };
    expect(atLimit.count).toBe(1n);
    expect(atLimit.secret).toBe("[REDACTED:aws-access-key]");
  });

  it("walks a 100000-level chain without overflowing the stack", () => {
    let value: unknown = "AKIAIOSFODNN7EXAMPLE";
    for (let i = 0; i < 100_000; i++) value = { n: value };
    let out: unknown;
    expect(() => {
      out = redactSecrets(value);
    }).not.toThrow();
    expect(descend(out, 100_000)).toBe("[REDACTED:aws-access-key]");
  });

  it("stops at the node budget instead of leaking past it", () => {
    const wide: Record<string, unknown> = { early: "AKIAIOSFODNN7EXAMPLE" };
    for (let i = 0; i < 100_050; i++) wide[`k${i}`] = { i };
    wide.tail = "plain-text-past-budget";
    const out = redactSecrets(nestObjects(wide, 10));
    const json = JSON.stringify(out) ?? "";
    expectNoSecret(json);
    const atLimit = descend(out, 10) as Record<string, unknown>;
    // The early sibling is reached before the budget runs out, so it is redacted.
    expect(atLimit.early).toBe("[REDACTED:aws-access-key]");
    // Later values keep their positions but lose their content, including a
    // string the detectors would otherwise have copied unchanged.
    expect(atLimit["k100049"]).toBe("[REDACTED:depth-limit]");
    expect(atLimit.tail).toBe("[REDACTED:depth-limit]");
    expect(json).toContain("[REDACTED:depth-limit]");
    expect(json).not.toContain("plain-text-past-budget");
  });

  it("stops at the character budget instead of copying a huge subtree", () => {
    const payload = { blob: "x".repeat(4_194_304 + 1), secret: "AKIAIOSFODNN7EXAMPLE" };
    const out = redactSecrets(nestObjects(payload, 10));
    const atLimit = descend(out, 10) as { blob: string; secret: string };
    expect(atLimit.blob).toBe("[REDACTED:depth-limit]");
    expect(atLimit.secret).toBe("[REDACTED:aws-access-key]");
    expect(JSON.stringify(out)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("caps a string that is itself the depth-limit value", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const out = redactSecrets(nestObjects(`${"x".repeat(4_194_304 + 1)}${secret}`, 8));
    expect(descend(out, 8)).toBe("[REDACTED:depth-limit]");
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it.each<[string, () => object]>([
    ["a throwing getter", () => Object.defineProperty({}, "secret", {
      enumerable: true,
      get() { throw new Error("read failed"); },
    })],
    ["a Proxy that refuses enumeration", () => new Proxy(
      { secret: SECRETS[0]! },
      { ownKeys() { throw new Error("ownKeys refused"); } },
    )],
  ])("fails closed when traversal throws (%s)", (_name, build) => {
    const out = redactSecrets(build());
    // Callers cast the result to a record, so the placeholder keeps that shape.
    expect(out).toEqual({ error: "[REDACTED:redaction-error]" });
    expectNoSecret(JSON.stringify(out) ?? "");
  });

  it("returns the bare placeholder when a string input fails", () => {
    const original = RegExp.prototype[Symbol.replace];
    try {
      RegExp.prototype[Symbol.replace] = () => {
        throw new Error("redaction failed");
      };
      expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:redaction-error]");
      expect(redactSecrets({ text: "AKIAIOSFODNN7EXAMPLE" })).toEqual({
        error: "[REDACTED:redaction-error]",
      });
    } finally {
      RegExp.prototype[Symbol.replace] = original;
    }
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:aws-access-key]");
  });

  it("does not redact short dummy keys in credentials fixtures", () => {
    const text = readFileSync("tests/credentials.test.ts", "utf-8");
    const out = String(redactSecrets(text));
    expect(out).not.toContain("[REDACTED:");
    expect(out).toContain("sk-test-123");
    expect(out).toContain("sk-ant-oat-access");
  });
});
