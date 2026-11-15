import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { redactSecrets, redactSecretsStrict } from "../src/redact/secrets.js";

/** Shape used by the depth matrix: a secret assignment and a bare AWS key. */
const SECRETS = [
  "ANTHROPIC_API_KEY=sk-ant-api03-" + "A".repeat(40),
  "AKIAIOSFODNN7EXAMPLE",
];
const SECRET_MARKERS = ["sk-ant-api03-", "AKIAIOSFODNN7EXAMPLE"];

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
    expect(redactSecrets(value)).toBe("[REDACTED:redaction-error]");
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

  it("does not walk deeper than 8 and redacts the serialized subtree instead", () => {
    let nested: unknown = "AKIAIOSFODNN7EXAMPLE";
    for (let i = 0; i < 9; i++) nested = { n: nested };
    const out = redactSecrets(nested) as { n: { n: unknown } };
    let cur: unknown = out;
    for (let i = 0; i < 8; i++) cur = (cur as { n: unknown }).n;
    expect(typeof cur).toBe("string");
    expect(String(cur)).toContain("[REDACTED:aws-access-key]");
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

  it.each<[string, () => object]>([
    ["a cycle", () => {
      const cyclic: Record<string, unknown> = { secret: SECRETS[0]! };
      cyclic.self = cyclic;
      return cyclic;
    }],
    ["a BigInt", () => ({ secret: SECRETS[0]!, count: 1n })],
    ["a throwing getter", () => Object.defineProperty({ secret: SECRETS[0]! }, "broken", {
      enumerable: true,
      get() { throw new Error("serialize failed"); },
    })],
  ])("fails closed on %s below the depth limit", (_name, build) => {
    const value = { shallow: "AKIAIOSFODNN7EXAMPLE", deep: nestObjects(build(), 12) };
    const run = () => redactSecrets(value);
    expect(run).not.toThrow();
    const out = run();
    const json = JSON.stringify(out) ?? "";
    expectNoSecret(json);
    expect(json).toContain("[REDACTED:depth-limit]");
    // The sibling secret above the limit is still walked and redacted.
    expect((out as { shallow: string }).shallow).toBe("[REDACTED:aws-access-key]");
  });

  it("replaces an over-size deep subtree with the depth-limit placeholder", () => {
    const payload = { secret: SECRETS[0]!, blob: "x".repeat(262_144 + 1) };
    const value = nestObjects(payload, 12);
    const out = redactSecrets(value);
    let cur: unknown = out;
    for (let i = 0; i < 8; i++) cur = (cur as { n: unknown }).n;
    expect(cur).toBe("[REDACTED:depth-limit]");
    expectNoSecret(JSON.stringify(out) ?? "");
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
    const value = build();
    const out = redactSecrets(value);
    expect(out).toBe("[REDACTED:redaction-error]");
    expectNoSecret(JSON.stringify(out) ?? "");
  });

  it("does not redact short dummy keys in credentials fixtures", () => {
    const text = readFileSync("tests/credentials.test.ts", "utf-8");
    const out = String(redactSecrets(text));
    expect(out).not.toContain("[REDACTED:");
    expect(out).toContain("sk-test-123");
    expect(out).toContain("sk-ant-oat-access");
  });
});
