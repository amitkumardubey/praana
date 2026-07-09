/**
 * Minimal OpenAI-compatible streaming server that intentionally omits `usage`.
 *
 * Why: lets us verify PRAANA's heuristic token fallback when provider usage
 * metadata is unavailable in streaming responses.
 *
 * Environment:
 * - `MOCK_OPENAI_NO_USAGE_HOST` (default: `127.0.0.1`)
 * - `MOCK_OPENAI_NO_USAGE_PORT` (default: `9999`)
 * - `MOCK_OPENAI_NO_USAGE_MODEL` (default: `mock/no-usage`)
 *
 * Endpoints:
 * - GET  /v1/models
 * - POST /v1/chat/completions (SSE streaming)
 *
 * Usage:
 *   bun run scripts/mock-openai-no-usage.ts
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;

function sendJson(res: http.ServerResponse, status: number, body: Json) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendSse(res: http.ServerResponse, data: Json) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      buf += chunk;
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function extractUserText(payload: any): string {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  const last = msgs.at(-1);
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const t = content.find((p: any) => p?.type === "text" && typeof p?.text === "string");
    return typeof t?.text === "string" ? t.text : "";
  }
  return "";
}

function chooseReply(userText: string): string {
  const m = userText.match(/exactly:\s*([^\n\r]+)/i);
  if (m?.[1]) return m[1].trim();
  // Explicit "say ok" phrasing for manual smoke tests.
  if (/^say\s+ok\b/i.test(userText.trim())) return "ok";
  return "mock-response";
}

const port = Number(process.env.MOCK_OPENAI_NO_USAGE_PORT ?? "9999");
const host = process.env.MOCK_OPENAI_NO_USAGE_HOST ?? "127.0.0.1";
const modelId = process.env.MOCK_OPENAI_NO_USAGE_MODEL ?? "mock/no-usage";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
    const path = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.end();

    if (req.method === "GET" && path === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: [
          {
            id: modelId,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "mock",
          },
        ],
      });
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      const raw = await readBody(req);
      let payload: any = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
      }

      const wantsStream = payload?.stream === true;
      const reply = chooseReply(extractUserText(payload));
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = typeof payload?.model === "string" ? payload.model : modelId;

      if (!wantsStream) {
        return sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: reply },
              finish_reason: "stop",
            },
          ],
        });
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      sendSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });

      const parts = reply.length <= 4 ? [reply] : reply.split(/(\s+)/).filter(Boolean);
      for (const part of parts) {
        sendSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        });
      }

      sendSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    return sendJson(res, 404, { error: { message: `No route: ${req.method ?? "?"} ${path}` } });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { message: err instanceof Error ? err.message : "Internal server error" },
      });
    } else {
      res.end();
    }
  }
});

server.on("error", (err) => {
  console.error("[mock-openai-no-usage] server error:", err);
  process.exit(1);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, host, () => {
  console.log(`[mock-openai-no-usage] listening on http://${host}:${port}/v1 (model=${modelId})`);
});
