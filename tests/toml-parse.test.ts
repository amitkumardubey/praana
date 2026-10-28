import { describe, it, expect } from "bun:test";
import { parseToml } from "../src/toml-parse.js";
import { deepMerge } from "../src/config.js";

describe("parseToml", () => {
  it("returns ordinary objects with a normal prototype", () => {
    const parsed = parseToml("[a]\nb = 1\n[[c]]\nd = 2\n") as Record<string, any>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.a)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.c[0])).toBe(Object.prototype);
    expect(`${parsed.a}`).toBe("[object Object]");
    expect(Object.prototype.hasOwnProperty.call(parsed.a, "b")).toBe(true);
  });

  it("parses integers beyond the safe range as rounded numbers instead of failing", () => {
    const parsed = parseToml("big = 9007199254740993\nsmall = 5\n[t]\nid = 771752188537605140\n") as Record<string, any>;
    expect(parsed.big).toBe(9007199254740992);
    expect(parsed.small).toBe(5);
    expect(typeof parsed.t.id).toBe("number");
  });

  it("still rejects integers outside the 64-bit range and syntax errors", () => {
    expect(() => parseToml("x = 99999999999999999999")).toThrow();
    expect(() => parseToml("a = = 1")).toThrow();
  });

  it("keeps offset date-times as Date and local values as strings", () => {
    const parsed = parseToml("d = 1979-05-27T07:32:00Z\nl = 1979-05-27\n") as Record<string, any>;
    expect(parsed.d).toBeInstanceOf(Date);
    expect(parsed.l).toBe("1979-05-27");
  });

  it("drops a __proto__ table and key", () => {
    const parsed = parseToml('[__proto__]\npolluted = true\n[ok]\nv = 1\n') as Record<string, any>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined();
    expect(parsed.ok.v).toBe(1);
  });
});

describe("deepMerge", () => {
  it("never lets an own __proto__ key change the merged object's prototype", () => {
    const hostile = JSON.parse('{"__proto__": {"injected": true}, "safe": 1}');
    const merged = deepMerge({ safe: 0 } as Record<string, unknown>, hostile);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as any).injected).toBeUndefined();
    expect(merged.safe).toBe(1);
  });
});
