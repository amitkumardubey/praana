import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { redactSecrets } from "../src/redact/secrets.js";

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

  it("does not walk deeper than 8", () => {
    let nested: unknown = "AKIAIOSFODNN7EXAMPLE";
    for (let i = 0; i < 9; i++) nested = { n: nested };
    const out = redactSecrets(nested) as { n: { n: unknown } };
    let cur: unknown = out;
    for (let i = 0; i < 8; i++) cur = (cur as { n: unknown }).n;
    expect(cur).toEqual({ n: "AKIAIOSFODNN7EXAMPLE" });
  });

  it("does not redact short dummy keys in credentials fixtures", () => {
    const text = readFileSync("tests/credentials.test.ts", "utf-8");
    const out = String(redactSecrets(text));
    expect(out).not.toContain("[REDACTED:");
    expect(out).toContain("sk-test-123");
    expect(out).toContain("sk-ant-oat-access");
  });
});
