import { describe, it, expect } from "bun:test";
import {
  formatProvidersCliOutput,
  listProvidersForCli,
  type ProviderCliEntry,
} from "../src/providers-cli.js";

describe("formatProvidersCliOutput", () => {
  it("prints available providers as bare names", () => {
    const entries: ProviderCliEntry[] = [
      { name: "nvidia", available: true },
      { name: "umans", available: true },
    ];
    expect(formatProvidersCliOutput(entries)).toBe("nvidia\numans");
  });

  it("annotates unavailable providers with a reason", () => {
    const entries: ProviderCliEntry[] = [
      {
        name: "anthropic",
        available: false,
        disabledReason: "Missing required env var: ANTHROPIC_API_KEY",
      },
      { name: "ollama", available: true },
    ];
    const output = formatProvidersCliOutput(entries);
    expect(output).toContain(
      "anthropic (unavailable: Missing required env var: ANTHROPIC_API_KEY)",
    );
    expect(output).toContain("ollama");
    expect(output).not.toContain("(available)");
  });

  it("returns guidance when empty", () => {
    expect(formatProvidersCliOutput([])).toMatch(/No configured providers/);
  });
});

describe("listProvidersForCli", () => {
  it("defaults to available providers only", () => {
    const entries = listProvidersForCli();
    expect(entries.every((e) => e.available)).toBe(true);
  });

  it("includeUnavailable lists providers without API keys", () => {
    const entries = listProvidersForCli({ includeUnavailable: true });
    expect(entries.some((e) => !e.available)).toBe(true);
    expect(entries.some((e) => e.available)).toBe(true);
  });
});
