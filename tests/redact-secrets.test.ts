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

/** Compare the redacted JSON projection, including the non-string root envelope. */
function expectProjection(input: unknown): unknown {
  const out = redactSecrets(input);
  expectNoSecret(JSON.stringify(out));
  const projected: unknown = JSON.parse(JSON.stringify(input));
  const redacted = redactSecrets(projected);
  const expected = typeof input !== "string" && typeof projected === "string"
    ? { error: redacted }
    : redacted;
  expect(out).toEqual(expected);
  const envelopeProjection = JSON.parse(JSON.stringify({ value: input }));
  expect(redactSecrets({ value: input })).toEqual(redactSecrets(envelopeProjection));
  return out;
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
    expect(redactSecrets(value)).toEqual({ broken: "[REDACTED:redaction-error]" });
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
    }
  });
});

describe("redactSecrets", () => {
  it("copies and redacts null-prototype objects, including __proto__", () => {
    const input = Object.assign(Object.create(null), { token: SECRETS[0] });
    Object.defineProperty(input, "__proto__", { value: SECRETS[1], enumerable: true });
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["token", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")).toEqual({
      value: "[REDACTED:aws-access-key]", enumerable: true, writable: true, configurable: true,
    });
    expectNoSecret(JSON.stringify(out));
    expectProjection(input);
  });

  it("redacts property names in the JSON projection", () => {
    expect(expectProjection({ [SECRETS[1]!]: "value" })).toEqual({
      "[REDACTED:aws-access-key]": "value",
    });
  });

  it("keeps colliding redacted keys with stable suffixes, including literal suffixes", () => {
    const input = {
      [SECRETS[1]!]: "first",
      "[REDACTED:aws-access-key]#2": "literal",
      ASIAIOSFODNN7EXAMPLE: "second",
      "[REDACTED:aws-access-key]": "third",
    };
    const out = expectProjection(input);
    expect(out).toEqual({
      "[REDACTED:aws-access-key]": "first",
      "[REDACTED:aws-access-key]#2": "literal",
      "[REDACTED:aws-access-key]#3": "second",
      "[REDACTED:aws-access-key]#4": "third",
    });
    expect(JSON.stringify(out)).not.toContain("ASIAIOSFODNN7EXAMPLE");
  });

  it("uses only own enumerable properties of Maps, Sets and other objects", () => {
    const values = [
      new Map([[SECRETS[0], SECRETS[1]]]), new Set(SECRETS),
      new WeakMap(), new WeakSet(), Promise.resolve(SECRETS[0]), /x/g,
      new Proxy(new Map([["key", SECRETS[1]]]), {}),
    ];
    for (const value of values) {
      expect(expectProjection(value)).toEqual({});
      Object.assign(value, { token: SECRETS[1] });
      expect(expectProjection(value)).toEqual({ token: "[REDACTED:aws-access-key]" });
    }
  });

  it("does not expose non-enumerable Error messages but redacts enumerable code and stack", () => {
    expect(expectProjection(new Error(SECRETS[0]))).toEqual({});
    const input = Object.assign(new Error(SECRETS[0]), { code: SECRETS[1] });
    expect(expectProjection(input)).toEqual({ code: "[REDACTED:aws-access-key]" });
    Object.defineProperty(input, "stack", { value: SECRETS[1], enumerable: true });
    expect(expectProjection(input)).toEqual({
      code: "[REDACTED:aws-access-key]", stack: "[REDACTED:aws-access-key]",
    });
    Object.defineProperty(input, "message", { value: SECRETS[1], enumerable: true });
    expect(expectProjection(input)).toEqual({
      code: "[REDACTED:aws-access-key]", stack: "[REDACTED:aws-access-key]", message: "[REDACTED:aws-access-key]",
    });
  });

  it("suppresses binary bytes before toJSON, without decoding or trusting byteLength", () => {
    const bytes = Buffer.from(SECRETS[1]!);
    for (const value of [bytes, new Uint8Array(bytes), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), new DataView(new Uint8Array(bytes).buffer)]) {
      const input = { value };
      const out = redactSecrets(input);
      expectNoSecret(JSON.stringify(out));
      expect(out).toEqual({ value: `[binary: ${bytes.byteLength} bytes]` });
      expect(JSON.stringify(out)).not.toContain(JSON.stringify([...bytes]));
      expect(redactSecrets(value)).toEqual({ error: `[binary: ${bytes.byteLength} bytes]` });
    }
    const hostile = new Uint8Array(bytes);
    Object.defineProperty(hostile, "byteLength", { get() { throw new Error("not trusted"); } });
    Object.assign(hostile, { toJSON() { throw new Error("must not run"); } });
    expect(redactSecrets({ hostile })).toEqual({ hostile: `[binary: ${bytes.byteLength} bytes]` });
  });

  it("projects URLs, Dates and classes with toJSON using the original property key", () => {
    const url = new URL(`https://example.com/?api_key=${SECRETS[1]}`);
    const date = new Date(0);
    class Custom { toJSON(key: string) { return `${key}: ${SECRETS[1]}`; } }
    expect(expectProjection({ url, date, custom: new Custom() })).toEqual({
      url: "https://example.com/?api_key=[REDACTED]",
      date: "1970-01-01T00:00:00.000Z", custom: "custom: [REDACTED:aws-access-key]",
    });
    expect(expectProjection(date)).toEqual({ error: "1970-01-01T00:00:00.000Z" });
    expect(expectProjection(new Custom())).toEqual({ error: ": [REDACTED:aws-access-key]" });
    expectProjection({ [SECRETS[1]!]: new Custom(), list: [new Custom()] });
    // JSON does not call toJSON again on the object returned by toJSON.
    expect(expectProjection({ toJSON() { return { token: SECRETS[1], toJSON() { return "wrong"; } }; } }))
      .toEqual({ token: "[REDACTED:aws-access-key]" });
  });

  it("calls toJSON once per value without consulting its call or apply properties", () => {
    let calls = 0;
    const toJSON = Object.assign(function (this: { token: string }, key: string) {
      calls++;
      expect(this.token).toBe(SECRETS[1]!);
      expect(key).toBe("item");
      return { token: this.token };
    }, { call() { throw new Error("hostile call"); }, apply() { throw new Error("hostile apply"); } });
    const out = redactSecrets({ item: { token: SECRETS[1]!, toJSON } });
    expect(calls).toBe(1);
    expectNoSecret(JSON.stringify(out));
    expect(out).toEqual({ item: { token: "[REDACTED:aws-access-key]" } });
    const binaryOut = redactSecrets({ item: { toJSON() { return Buffer.from(SECRETS[1]!); } } });
    expectNoSecret(JSON.stringify(binaryOut));
    expect(binaryOut).toEqual({ item: `[binary: ${Buffer.byteLength(SECRETS[1]!)} bytes]` });
  });

  it("walks class enumerable fields, never private, hidden or inherited fields", () => {
    class Custom {
      token = SECRETS[1];
      #private = SECRETS[0];
      constructor() { Object.defineProperty(this, "hidden", { value: this.#private }); }
    }
    Object.assign(Custom.prototype, { inherited: SECRETS[1] });
    const out = expectProjection(new Custom());
    expect(out).toEqual({ token: "[REDACTED:aws-access-key]" });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("omits unsupported object values and uses null in arrays, including holes", () => {
    const fn = Object.assign(() => SECRETS[1], { token: SECRETS[1] });
    const values = [fn, undefined, Symbol(SECRETS[1]), , SECRETS[1]];
    expect(expectProjection({ fn, undef: undefined, sym: Symbol(SECRETS[1]), values })).toEqual({
      values: [null, null, null, null, "[REDACTED:aws-access-key]"],
    });
    // Callable objects can have toJSON too.
    Object.assign(fn, { toJSON(key: string) { return `${key}: ${SECRETS[1]}`; } });
    expectProjection({ fn });
  });

  it("projects array indices (including inherited ones), not enumerable extra keys", () => {
    const array = [, SECRETS[1]];
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "0", { value: SECRETS[1] });
    Object.setPrototypeOf(array, prototype);
    Object.assign(array, { [SECRETS[1]!]: SECRETS[1] });
    expect(expectProjection(array)).toEqual(["[REDACTED:aws-access-key]", "[REDACTED:aws-access-key]"]);
    const proxy = new Proxy([SECRETS[1]], { ownKeys() { return ["length"]; } });
    expect(expectProjection({ proxy, sibling: SECRETS[1] })).toEqual({
      proxy: ["[REDACTED:aws-access-key]"], sibling: "[REDACTED:aws-access-key]",
    });
  });

  it("projects boxed primitives and non-finite numbers", () => {
    for (const value of [new String(SECRETS[1]), new Number(42), new Boolean(false), Object(Symbol(SECRETS[1])), NaN, Infinity, -Infinity, -0, null, true, 7]) {
      expectProjection({ value });
    }
    expectProjection({ value: Object.assign(new Number(1), { valueOf: () => 2 }) });
    expectProjection({ value: Object.assign(new String("safe"), { toString: () => SECRETS[1] }) });
  });

  it("keeps a container for every non-string root, including scalar projections", () => {
    for (const value of [null, true, 42, NaN, undefined, Symbol("x"), () => SECRETS[1], new (class { toJSON() { return SECRETS[1]; } })()]) {
      const out = redactSecrets(value);
      expect(out).not.toBeNull();
      expect(typeof out).toBe("object");
      expectNoSecret(JSON.stringify(out));
    }
  });

  it("isolates throwing getters and enumeration failures", () => {
    const broken = Object.defineProperty({ safe: SECRETS[0] }, "bad", {
      enumerable: true, get() { throw new Error("bad"); },
    });
    const proxy = new Proxy({ secret: SECRETS[1] }, { ownKeys() { throw new Error("bad"); } });
    const out = redactSecrets({ broken, proxy, sibling: SECRETS[1] });
    expect(out).toEqual({ broken: { safe: "ANTHROPIC_API_KEY=[REDACTED:key-assignment]", bad: "[REDACTED:redaction-error]" }, proxy: "[REDACTED:redaction-error]", sibling: "[REDACTED:aws-access-key]" });
    expectNoSecret(JSON.stringify(out));
  });

  it("isolates throwing toJSON, toJSON getters and revoked proxies to their values", () => {
    const throwing = { toJSON() { throw new Error(SECRETS[1]); } };
    const getter = Object.defineProperty({}, "toJSON", { get() { throw new Error(SECRETS[1]); } });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const out = redactSecrets({ throwing, getter, proxy, sibling: SECRETS[1] });
    expectNoSecret(JSON.stringify(out));
    expect(out).toEqual({
      throwing: "[REDACTED:redaction-error]", getter: "[REDACTED:redaction-error]",
      proxy: "[REDACTED:redaction-error]", sibling: "[REDACTED:aws-access-key]",
    });
    expect(redactSecrets(throwing)).toEqual({ error: "[REDACTED:redaction-error]" });
  });

  it("bounds a self-referencing ten-key object in under 50 ms", () => {
    const input: Record<string, unknown> = { secret: SECRETS[1] };
    for (let i = 0; i < 9; i++) input[`self${i}`] = input;
    expect(Object.keys(input)).toHaveLength(10);
    const start = performance.now();
    const out = redactSecrets(input);
    expect(performance.now() - start).toBeLessThan(50);
    const json = JSON.stringify(out);
    expectNoSecret(json);
    expect(json).toContain("[REDACTED:cycle]");
    for (let i = 0; i < 9; i++) expect((out as Record<string, unknown>)[`self${i}`]).toBe("[REDACTED:cycle]");
  });

  it("uses the cycle placeholder for shared containers as well as cycles", () => {
    const shared = { secret: SECRETS[1] };
    const out = redactSecrets({ first: shared, second: shared });
    expectNoSecret(JSON.stringify(out));
    expect(out).toEqual({ first: { secret: "[REDACTED:aws-access-key]" }, second: "[REDACTED:cycle]" });
  });

  it("projects null-prototype objects and Maps identically past the old depth limit", () => {
    const value = Object.assign(Object.create(null), { secret: SECRETS[0], map: new Map([["key", SECRETS[1]]]) });
    const out = descend(redactSecrets(nestObjects(value, 8)), 8) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.secret).toBe("ANTHROPIC_API_KEY=[REDACTED:key-assignment]");
    expect(out.map).toEqual({});
    expectNoSecret(JSON.stringify(out));
    expectProjection(nestObjects(value, 8));
  });
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

  it("walks deeper than 8 while keeping the JSON shape", () => {
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
        expectProjection(nest(secret, depth));
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
    ["a function", () => () => "AKIAIOSFODNN7EXAMPLE"],
    ["a typed array", () => new Uint8Array(4)],
  ])("redacts %s consistently at depth 10", (_name, build) => {
    const input = nestObjects(build(), 10);
    const out = redactSecrets(input);
    expectNoSecret(JSON.stringify(out));
    if (_name === "a typed array") expect(descend(out, 10)).toBe("[binary: 4 bytes]");
    else expectProjection(input);
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

  it("uses redacted decimal strings for BigInt, including boxed values", () => {
    const out = redactSecrets(nestObjects({ secret: SECRETS[1], count: 1n, boxed: Object(2n) }, 12));
    const leaf = descend(out, 12);
    expect(leaf).toEqual({ secret: "[REDACTED:aws-access-key]", count: "1", boxed: "2" });
    expectNoSecret(JSON.stringify(out));
    expect(redactSecrets(123n)).toEqual({ error: "123" });
  });

  it("bounds a 100000-level chain without overflowing the stack", () => {
    let value: unknown = "AKIAIOSFODNN7EXAMPLE";
    for (let i = 0; i < 100_000; i++) value = { n: value };
    let out: unknown;
    expect(() => {
      out = redactSecrets(value);
    }).not.toThrow();
    expect(descend(out, 100_000)).toBe("[REDACTED:depth-limit]");
  });

  it("stops at the node budget instead of leaking past it", () => {
    const wide: Record<string, unknown> = { early: "AKIAIOSFODNN7EXAMPLE" };
    for (let i = 0; i < 100_050; i++) wide[`k${i}`] = { i };
    wide.tail = "plain-text-past-budget";
    const out = redactSecrets(nestObjects(wide, 10));
    const json = JSON.stringify(out) ?? "";
    expectNoSecret(json);
    // A container whose property slots cannot fit is replaced as a unit.
    expect(descend(out, 10)).toBe("[REDACTED:depth-limit]");
    expect(json).toContain("[REDACTED:depth-limit]");
    expect(json).not.toContain("plain-text-past-budget");
  });

  it("bounds wide primitive objects and sparse arrays before reading their values", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 100_001; i++) wide[`k${i}`] = SECRETS[1];
    let reads = 0;
    const array = new Proxy(new Array(2 ** 32 - 1), {
      get(target, key, receiver) {
        if (key === "0") reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const out = redactSecrets({ wide, array, sibling: SECRETS[1] });
    expectNoSecret(JSON.stringify(out));
    expect(out).toEqual({ wide: "[REDACTED:depth-limit]", array: "[REDACTED:depth-limit]", sibling: "[REDACTED:aws-access-key]" });
    expect(reads).toBe(0);
  });

  it("caps property-name characters as well as string leaves", () => {
    const input = { [`${"x".repeat(4_194_305)} ${SECRETS[1]}`]: SECRETS[1], sibling: SECRETS[1] };
    const out = redactSecrets(input);
    expectNoSecret(JSON.stringify(out));
    expect(out).toEqual({ "[REDACTED:depth-limit]": "[REDACTED:aws-access-key]", sibling: "[REDACTED:aws-access-key]" });
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

  it("fails closed when root enumeration throws", () => {
    const out = redactSecrets(new Proxy({ secret: SECRETS[0]! }, {
      ownKeys() { throw new Error("ownKeys refused"); },
    }));
    expect(out).toEqual({ error: "[REDACTED:redaction-error]" });
  });

  it("returns the bare placeholder when a string input fails", () => {
    const original = RegExp.prototype[Symbol.replace];
    try {
      RegExp.prototype[Symbol.replace] = () => {
        throw new Error("redaction failed");
      };
      expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:redaction-error]");
      expect(redactSecrets({ text: "AKIAIOSFODNN7EXAMPLE" })).toEqual({
        "[REDACTED:redaction-error]": "[REDACTED:redaction-error]",
      });
    } finally {
      RegExp.prototype[Symbol.replace] = original;
    }
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:aws-access-key]");
  });

  it("redacts seeded randomized JSON projections without throwing", () => {
    let state = 0x782;
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const seen = new Set<number>();
    // The oracle differs only by replacing binary leaves before JSON projection.
    const build = (depth: number): [unknown, unknown] => {
      const kind = depth === 0 ? 7 + random() % 2 : random() % 9;
      seen.add(kind);
      if (kind === 7) return [`log ${SECRETS[1]} end`, `log ${SECRETS[1]} end`];
      if (kind === 8) { const n = random(); return [n, n]; }
      if (kind === 4) { const d = new Date(random()); return [d, d.toJSON()]; }
      if (kind === 5) { const b = Buffer.from(SECRETS[1]!); return [b, `[binary: ${b.length} bytes]`]; }
      const children = Array.from({ length: 1 + random() % 3 }, () => build(depth - 1));
      if (kind === 2) return [new Map(children.map(([raw], i) => [i, raw])), {}];
      if (kind === 3) return [new Set(children.map(([raw]) => raw)), {}];
      if (kind === 1) return [children.map(([raw]) => raw), children.map(([, projected]) => projected)];
      const raw = kind === 6 ? Object.create(null) as Record<string, unknown> : {} as Record<string, unknown>;
      const projected: Record<string, unknown> = {};
      children.forEach(([a, b], i) => {
        const key = i === 0 ? SECRETS[1]! : `k${i}`;
        raw[key] = a;
        projected[key] = b;
      });
      return [raw, projected];
    };
    for (let i = 0; i < 300; i++) {
      const [value, projected] = build(4);
      let out: unknown;
      expect(() => { out = redactSecrets({ value }); }).not.toThrow();
      expectNoSecret(JSON.stringify(out));
      expect(out).toEqual(redactSecrets(JSON.parse(JSON.stringify({ value: projected }))));
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("does not redact short dummy keys in credentials fixtures", () => {
    const text = readFileSync("tests/credentials.test.ts", "utf-8");
    const out = String(redactSecrets(text));
    expect(out).not.toContain("[REDACTED:");
    expect(out).toContain("sk-test-123");
    expect(out).toContain("sk-ant-oat-access");
  });
});
