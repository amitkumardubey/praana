// Local OpenAI-compatible mock. It never forwards requests to a provider.
import http from "node:http";

export const fixture = `# Streaming markdown fixture

A **bold** claim, *italic* text, and \`inline code\` alongside [a link](https://example.com/a/long/path).

## Nested list

- Item 01: a short first item
- Item 02: another item
  - Item 03: nested one
  - Item 04: nested two
    - Item 05: deeply nested
    - Item 06: another deep item
- Item 07: back at the top
- Item 08: text with **emphasis**
  - Item 09: child
  - Item 10: second child
- Item 11: more text
- Item 12: more text
- Item 13: last item

## Tasks

- [ ] Pending work
- [x] Completed work

## Code

\`\`\`ts
export function add(a: number, b: number) {
  return a + b;
}
\`\`\`

\`\`\`
plain code without a language
second line
\`\`\`

~~~
tildes fence this code
~~~

## Table

| Name | Value | Notes |
|------|-------|-------|
| alpha | 1 | first |
| beta | 22 | second row is longer |
| gamma | 333 | third |

> A blockquote with a list:
> - quoted first item
> - quoted second item

This deliberately long paragraph wraps across the viewport at both sizes and continues with enough words to cross more than one line, exercising incremental wrapping while the answer grows and the viewport follows the newest content. The quick brown fox jumps over the lazy dog while another sentence keeps the layout changing in small increments.

Emoji and wide characters: 日本語のテキスト 😀 👨‍👩‍👧 done.
`;

export function tokenize(text: string): string[] {
  return text.match(/\s+|\S{1,4}/gu) ?? [text];
}

export function responseMode(text: string, delay: number) {
  return { delay: /slow/i.test(text) ? 60 : delay, stall: /stall/i.test(text), cut: /cut/i.test(text) };
}

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 0 || (name === "--port" && (value < 1 || value > 65535))) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function startMock(port: number, delayMs: number) {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.includes("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let json: any = {};
    try { json = JSON.parse(body); } catch { /* Retain the original mock's empty-body behavior. */ }
    const messages: any[] = json.messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : "";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", model: "mock-model" };
    if (!messages.some((message) => message.role === "tool") && /read the readme/i.test(text) && (json.tools?.length ?? 0) > 0) {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] } }] });
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "README.md" }) } }] } }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.end("data: [DONE]\n\n");
      return;
    }
    const mode = responseMode(text, delayMs);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    let count = 0;
    for (const token of tokenize(fixture)) {
      if (res.destroyed) return;
      send({ ...base, choices: [{ index: 0, delta: { content: token } }] });
      await sleep(mode.delay);
      if (++count >= 12 && mode.stall) return; // Leave the response open until the client disconnects.
      if (count >= 12 && mode.cut) { res.end(); return; }
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
  }).listen(port, "127.0.0.1", () => console.log(`mock llm on ${port}`));
}

if (import.meta.main) startMock(option("--port", 9779), option("--delay-ms", 12));
