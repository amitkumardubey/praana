import { describe, expect, it } from "bun:test";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import type { ConversationMessage } from "../src/llm/types.js";

const asst = (n: number): ConversationMessage => ({
  role: "assistant",
  content: "",
  toolCalls: Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, name: `t${i + 1}`, args: {} })),
});
const res = (i: number, isError = false): ConversationMessage => ({
  role: "tool_result",
  toolCallId: `c${i}`,
  toolName: `t${i}`,
  result: `r${i}`,
  isError,
});

const bedrock = (messages: ConversationMessage[]) =>
  (new BedrockDriver() as any).formatMessages(messages).messages as Array<{ role: string; content: any[] }>;
const google = (messages: ConversationMessage[]) =>
  (new GoogleDriver() as any).formatContents(messages).contents as Array<{ role: string; parts: any[] }>;

describe("parallel tool results share one message", () => {
  for (const n of [2, 3]) {
    it(`bedrock: ${n} results become one user message in call order`, () => {
      const out = bedrock([{ role: "user", content: "go" }, asst(n), ...Array.from({ length: n }, (_, i) => res(i + 1))]);
      expect(out).toHaveLength(3);
      expect(out[2]!.role).toBe("user");
      expect(out[2]!.content.map((b) => b.toolResult.toolUseId)).toEqual(Array.from({ length: n }, (_, i) => `c${i + 1}`));
    });

    it(`google: ${n} results become one user content in call order`, () => {
      const out = google([{ role: "user", content: "go" }, asst(n), ...Array.from({ length: n }, (_, i) => res(i + 1))]);
      expect(out).toHaveLength(3);
      expect(out[2]!.role).toBe("user");
      expect(out[2]!.parts.map((p) => p.functionResponse.name)).toEqual(Array.from({ length: n }, (_, i) => `t${i + 1}`));
    });
  }

  it("keeps a single result unchanged", () => {
    expect(bedrock([asst(1), res(1, true)])[1]).toEqual({
      role: "user",
      content: [{ toolResult: { toolUseId: "c1", content: [{ text: "r1" }], status: "error" } }],
    });
    expect(google([asst(1), res(1)])[1]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "t1", response: { output: "r1", isError: false } } }],
    });
  });

  it("does not merge a result with a following user message or a later batch", () => {
    const messages: ConversationMessage[] = [
      asst(2), res(1), res(2),
      { role: "user", content: "next" },
      asst(1), res(1),
    ];
    const b = bedrock(messages);
    expect(b.map((m) => m.role)).toEqual(["assistant", "user", "user", "assistant", "user"]);
    expect(b[1]!.content).toHaveLength(2);
    expect(b[2]!.content).toEqual([{ text: "next" }]);
    expect(b[4]!.content).toHaveLength(1);
    const g = google(messages);
    expect(g.map((m) => m.role)).toEqual(["model", "user", "user", "model", "user"]);
    expect(g[1]!.parts).toHaveLength(2);
    expect(g[4]!.parts).toHaveLength(1);
  });
});
