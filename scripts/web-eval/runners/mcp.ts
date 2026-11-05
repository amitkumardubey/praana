import { classifyError, defaultRequest, RunnerError, string, USER_AGENT, type RunnerDeps } from "./base.js";

async function rpcReply(response: Response, id: number): Promise<any> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const message = await response.json() as any;
    if (message?.jsonrpc !== "2.0" || message.id !== id) throw new RunnerError("other");
    return message;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RunnerError("other");
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > 2_000_000) throw new RunnerError("other");
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const message = JSON.parse(data);
        if (message.jsonrpc === "2.0" && message.id === id) return message;
      }
      if (done) throw new RunnerError("other");
    }
  } finally { await reader.cancel(); }
}

/** Minimal Streamable HTTP client. No reconnects, session resets, polling or hidden retries. */
export function createMcpClient(endpoint: string, deps: RunnerDeps) {
  let session: string | undefined;
  let protocol = "2025-03-26";
  let nextId = 1;
  let initialized = false;
  async function send(method: string, params?: unknown, notification = false) {
    const id = notification ? undefined : nextId++;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": USER_AGENT };
    if (session) headers["Mcp-Session-Id"] = session;
    if (method !== "initialize") headers["MCP-Protocol-Version"] = protocol;
    const response = await (deps.request ?? defaultRequest)(endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!response.ok) throw new RunnerError(classifyError(response.status, await response.text()), response.status);
    session = response.headers.get("mcp-session-id") ?? session;
    if (notification) { await response.body?.cancel(); return; }
    const message = await rpcReply(response, id!);
    if (message.error) throw new RunnerError(classifyError(undefined, JSON.stringify(message.error)));
    if (!message.result || typeof message.result !== "object") throw new RunnerError("other");
    return message.result;
  }
  return {
    async call(name: string, args: Record<string, unknown>): Promise<any> {
      if (!initialized) {
        const result = await send("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "praana-web-eval", version: "0.1" } });
        if (!["2025-03-26", "2025-06-18", "2025-11-25"].includes(result.protocolVersion)) throw new RunnerError("other");
        protocol = result.protocolVersion;
        await send("notifications/initialized", undefined, true);
        initialized = true;
      }
      const result = await send("tools/call", { name, arguments: args });
      if (result.isError) throw new RunnerError(classifyError(undefined, mcpText(result)));
      return result;
    },
  };
}

export function mcpText(result: any): string {
  if (!Array.isArray(result?.content)) throw new RunnerError("other");
  return result.content.filter((part: any) => part.type === "text").map((part: any) => string(part.text)).join("\n");
}
export function mcpJson(result: any): any {
  return result.structuredContent ?? JSON.parse(mcpText(result));
}
