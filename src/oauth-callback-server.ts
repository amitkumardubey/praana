import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface OAuthCallbackServer {
  wait(): Promise<string>;
  close(): void;
}

export interface OAuthCallbackOptions {
  state: string;
  signal: AbortSignal;
}

export type CallbackServerFactory = (
  options: OAuthCallbackOptions,
) => Promise<OAuthCallbackServer | undefined>;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Returns undefined when the fixed loopback port cannot be bound (manual fallback). */
export async function startOAuthCallbackServer(
  { state, signal }: OAuthCallbackOptions,
  serverFactory: (handler: (req: IncomingMessage, res: ServerResponse) => void) => Server = createServer,
): Promise<OAuthCallbackServer | undefined> {
  signal.throwIfAborted();
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // Closing an unused callback (manual input won) must not leave an unhandled rejection.
  void result.catch(() => {});
  const finish = (code?: string, error?: Error) => {
    if (settled) return;
    settled = true;
    if (error) reject(error);
    else resolve(code!);
  };
  const server = serverFactory((req, res) => {
    const page = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><html><head><title>PRAANA authorization</title></head><body><p>${escapeHtml(message)}</p></body></html>`);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1:1455");
    } catch {
      page(400, "Malformed request target.");
      return;
    }
    const hostHeader = req.headers.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (host !== "localhost:1455" && host !== "127.0.0.1:1455") {
      page(400, "Invalid host.");
      return;
    }
    if (req.method !== "GET" || url.pathname !== "/auth/callback") {
      page(404, "Callback route not found.");
    } else if (url.searchParams.get("state") !== state) {
      page(400, "State mismatch.");
    } else if (settled) {
      page(409, "This authorization has already been handled.");
    } else if (url.searchParams.has("error")) {
      const message = `OpenAI Codex authorization failed: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`;
      page(400, message);
      finish(undefined, new Error(message));
    } else {
      const code = url.searchParams.get("code");
      if (!code) {
        page(400, "Missing authorization code.");
        return;
      }
      page(200, "Authorization received; return to PRAANA.");
      finish(code);
    }
  });
  const close = () => {
    signal.removeEventListener("abort", onAbort);
    finish(undefined, new Error("OAuth callback server closed"));
    server.close();
  };
  const onAbort = () => {
    finish(undefined, new Error("OpenAI Codex login cancelled or timed out"));
    close();
  };
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(1455, "127.0.0.1", () => {
        server.off("error", no);
        yes();
      });
    });
  } catch (error) {
    close();
    signal.throwIfAborted();
    if ((error as { code?: string }).code === "EADDRINUSE") return undefined;
    throw error;
  }
  server.on("error", (error) => { finish(undefined, error); close(); });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return { wait: () => result, close };
}
