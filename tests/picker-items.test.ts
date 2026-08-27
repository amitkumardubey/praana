import { describe, expect, it } from "bun:test";
import {
  filterPickerOptions,
  toPaletteOptions,
} from "../src/ui/tui/overlays/picker-items.js";

describe("filterPickerOptions", () => {
  const options = [
    { value: "openrouter", name: "openrouter", description: "OPENROUTER_API_KEY" },
    { value: "openai", name: "openai", description: "✓ OPENAI_API_KEY detected", aliases: ["gpt", "chatgpt"] },
    { value: "openai-codex", name: "openai-codex", description: "ChatGPT Plus/Pro Codex OAuth", aliases: ["codex", "chatgpt"] },
    { value: "anthropic", name: "anthropic", description: "API key or Claude Pro/Max OAuth", aliases: ["claude"] },
    { value: "amazon-bedrock", name: "amazon-bedrock", description: "Configure separately", aliases: ["bedrock", "aws"] },
    { value: "google", name: "google", description: "GOOGLE_GENERATIVE_AI_API_KEY", aliases: ["gemini"] },
  ];

  it("preserves order when the query is empty", () => {
    expect(filterPickerOptions(options, "")).toEqual(options);
    expect(filterPickerOptions(options, "   ")).toEqual(options);
  });

  it("ranks id prefix matches ahead of later subsequence hits", () => {
    expect(filterPickerOptions(options, "openai").map((o) => o.value)).toEqual([
      "openai",
      "openai-codex",
    ]);
    expect(filterPickerOptions(options, "open").map((o) => o.value)).toEqual([
      "openrouter",
      "openai",
      "openai-codex",
    ]);
  });

  it("does not match env-key text in the description", () => {
    expect(
      filterPickerOptions(options, "OPENROUTER_API_KEY").map((o) => o.value),
    ).toEqual([]);
  });

  it("finds providers by alias and hyphenated id segment", () => {
    expect(filterPickerOptions(options, "claude").map((o) => o.value)).toEqual([
      "anthropic",
    ]);
    expect(filterPickerOptions(options, "bedrock").map((o) => o.value)).toEqual([
      "amazon-bedrock",
    ]);
    expect(filterPickerOptions(options, "gemini").map((o) => o.value)).toEqual([
      "google",
    ]);
    expect(filterPickerOptions(options, "gpt").map((o) => o.value)[0]).toBe(
      "openai",
    );
  });

  it("keeps ambiguous aliases like chatgpt as a filtered list", () => {
    expect(filterPickerOptions(options, "chatgpt").map((o) => o.value)).toEqual([
      "openai",
      "openai-codex",
    ]);
  });
});

describe("toPaletteOptions", () => {
  it("copies aliases through for picker search", () => {
    expect(
      toPaletteOptions([
        { label: "anthropic", value: "anthropic", description: "key", aliases: ["claude"] },
      ]),
    ).toEqual([
      { name: "anthropic", value: "anthropic", description: "key", aliases: ["claude"] },
    ]);
  });
});
