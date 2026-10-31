import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getApiKey,
  getCredentialsFilePath,
  getOAuthToken,
  removeCredentials,
  resetCredentialStoreForTests,
  setApiKey,
  setOAuthToken,
} from "../src/credentials.js";
import { streamLlmResponse } from "../src/llm/stream.js";
import type { StreamEvent } from "../src/llm/types.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import {
  resetOAuthProvidersForTests,
  resolveOAuthModelAuth,
} from "../src/oauth.js";
import { Session } from "../src/session.js";
import { runTurn } from "../src/turn.js";
import type { PraanaConfig } from "../src/types.js";

/**
 * Logout vs refresh:
 * A refresh writes the rotated credential only while it still holds the
 * credential lock, and only when the stored entry is still the same refresh
 * token it exchanged. A logout that removes the provider before that write
 * (including one that runs while the refresh request is in flight) is not
 * undone. A logout that runs after the refresh commits deletes the rotated
 * credential and stays deleted. Aborting the caller after the refresh request
 * has started does not drop a successful rotation.
 */

const jwt = (id: string) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`;

function tokenJson(access: string, refresh: string) {
  return { access_token: access, refresh_token: refresh, expires_in: 3600 };
}

function lockPath(): string {
  return `${getCredentialsFilePath()}.lock`;
}

function writeLock(pid: number, startedAt = Date.now()): void {
  const path = lockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, startedAt }), { mode: 0o600 });
}

function seedExpiredCodex(refresh = "refresh-old", access = jwt("stored-account")): void {
  setOAuthToken("openai-codex", {
    access,
    refresh,
    expires: Date.now() - 5_000,
    accountId: "stored-account",
  });
}

function waitExit(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFile(path: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

describe("serialized OAuth refresh", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;
  const warnings: string[] = [];

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-oauth-refresh-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    warnings.length = 0;
    setAppLogger(new PraanaLogger({
      domain: "credentials",
      writeLine: (line) => { warnings.push(line); },
    }));
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("unexpected network call"); }) as typeof fetch;
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests();
    globalThis.fetch = originalFetch;
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("uses one refresh for two concurrent callers and returns the same token", async () => {
    seedExpiredCodex();
    let posts = 0;
    const next = jwt("refreshed-account");
    resetOAuthProvidersForTests({
      fetch: (async () => {
        posts += 1;
        await Promise.resolve();
        return Response.json(tokenJson(next, "refresh-rotated"));
      }) as typeof fetch,
    });
    const [a, b] = await Promise.all([
      resolveOAuthModelAuth("openai-codex"),
      resolveOAuthModelAuth("openai-codex"),
    ]);
    expect(posts).toBe(1);
    expect(a?.apiKey).toBe(next);
    expect(b?.apiKey).toBe(next);
    expect(getOAuthToken("openai-codex")).toMatchObject({ access: next, refresh: "refresh-rotated" });
  });

  it("uses one refresh when two concurrent callers both fail", async () => {
    seedExpiredCodex();
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => {
        posts += 1;
        await Promise.resolve();
        throw new Error("network down");
      }) as typeof fetch,
    });
    const [a, b] = await Promise.allSettled([
      resolveOAuthModelAuth("openai-codex"),
      resolveOAuthModelAuth("openai-codex"),
    ]);
    expect(posts).toBe(1);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    if (a.status === "rejected") {
      expect(String((a.reason as Error).message)).toContain("OpenAI Codex session expired and could not be refreshed: network down");
      expect(String((a.reason as Error).message)).toContain("Run /login openai-codex again");
      expect((a.reason as Error).name).toBe("OAuthRefreshError");
    }
  });

  it("does not refresh when another writer already stored a fresh token on disk", async () => {
    seedExpiredCodex();
    const fresh = jwt("already-fresh");
    const credPath = getCredentialsFilePath();
    const parsed = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, Record<string, unknown>>;
    parsed["openai-codex"] = {
      ...parsed["openai-codex"],
      access: fresh,
      refresh: "refresh-fresh",
      expires: Date.now() + 3_600_000,
    };
    writeFileSync(credPath, JSON.stringify(parsed));
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { posts += 1; throw new Error("refresh should not run"); }) as typeof fetch,
    });
    const auth = await resolveOAuthModelAuth("openai-codex");
    expect(posts).toBe(0);
    expect(auth?.apiKey).toBe(fresh);
  });

  it("does not start a refresh when the caller is already cancelled", async () => {
    seedExpiredCodex();
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { posts += 1; throw new Error("refresh should not run"); }) as typeof fetch,
    });
    const signal = AbortSignal.abort(new DOMException("The operation was aborted.", "AbortError"));
    await expect(resolveOAuthModelAuth("openai-codex", signal)).rejects.toThrow(/abort/i);
    expect(posts).toBe(0);
    expect(getOAuthToken("openai-codex")?.refresh).toBe("refresh-old");
  });

  it("persists a rotation that succeeds after the caller cancels", async () => {
    seedExpiredCodex();
    const next = jwt("rotated-after-cancel");
    const caller = new AbortController();
    let release!: (response: Response) => void;
    let sawAbortedRequest = false;
    resetOAuthProvidersForTests({
      fetch: ((_url, init) => {
        if (init?.signal?.aborted) sawAbortedRequest = true;
        init?.signal?.addEventListener("abort", () => { sawAbortedRequest = true; }, { once: true });
        return new Promise<Response>((resolve) => {
          release = resolve;
          caller.abort();
        });
      }) as typeof fetch,
    });
    const pending = resolveOAuthModelAuth("openai-codex", caller.signal);
    await Promise.resolve();
    release(Response.json(tokenJson(next, "refresh-after-cancel")));
    const auth = await pending;
    expect(sawAbortedRequest).toBe(false);
    expect(auth?.apiKey).toBe(next);
    expect(getOAuthToken("openai-codex")).toMatchObject({ access: next, refresh: "refresh-after-cancel" });
  });

  it("keeps another provider written during a refresh", async () => {
    seedExpiredCodex();
    setApiKey("anthropic", "sk-before");
    const dir = mkdtempSync(join(tmpdir(), "praana-refresh-writer-"));
    const started = join(dir, "started");
    const script = join(dir, "write-other.ts");
    const repo = join(import.meta.dir, "..");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      import { setApiKey } from ${JSON.stringify(pathToFileURL(join(repo, "src/credentials.ts")).href)};
      writeFileSync(${JSON.stringify(started)}, "1");
      setApiKey("openrouter", "sk-during-refresh");
    `);
    const next = jwt("refreshed-account");
    let child: ChildProcess | undefined;
    let exitP: Promise<{ code: number | null; stdout: string; stderr: string }> | undefined;
    resetOAuthProvidersForTests({
      fetch: (async () => {
        child = spawn(process.execPath, [script], {
          env: { ...process.env, PRAANA_HOME: praanaHome },
          stdio: ["ignore", "pipe", "pipe"],
        });
        exitP = waitExit(child);
        await waitForFile(started);
        await Promise.race([exitP.then(() => undefined), Bun.sleep(400)]);
        return Response.json(tokenJson(next, "refresh-rotated"));
      }) as typeof fetch,
    });
    try {
      const auth = await resolveOAuthModelAuth("openai-codex");
      const finished = await exitP;
      expect(finished?.code, finished?.stderr).toBe(0);
      expect(auth?.apiKey).toBe(next);
      resetCredentialStoreForTests();
      expect(getApiKey("openrouter")).toBe("sk-during-refresh");
      expect(getApiKey("anthropic")).toBe("sk-before");
      expect(getOAuthToken("openai-codex")?.refresh).toBe("refresh-rotated");
    } finally {
      child?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let an in-flight refresh undo logout", async () => {
    seedExpiredCodex();
    const next = jwt("should-not-stick");
    resetOAuthProvidersForTests({
      fetch: (async () => {
        removeCredentials("openai-codex");
        return Response.json(tokenJson(next, "refresh-stale"));
      }) as typeof fetch,
    });
    const auth = await resolveOAuthModelAuth("openai-codex");
    expect(auth).toBeNull();
    expect(getOAuthToken("openai-codex")).toBeUndefined();
    await Bun.sleep(20);
    expect(getOAuthToken("openai-codex")).toBeUndefined();
  });

  it("keeps a logout that runs after a refresh commits", async () => {
    seedExpiredCodex();
    const next = jwt("refreshed-account");
    resetOAuthProvidersForTests({
      fetch: (async () => Response.json(tokenJson(next, "refresh-rotated"))) as typeof fetch,
    });
    const pending = resolveOAuthModelAuth("openai-codex");
    const loggedOut = pending.then(() => removeCredentials("openai-codex"));
    await pending;
    expect(loggedOut).resolves.toBe(true);
    await loggedOut;
    expect(getOAuthToken("openai-codex")).toBeUndefined();
    await Bun.sleep(20);
    expect(getOAuthToken("openai-codex")).toBeUndefined();
  });

  it("recovers a credential lock left by a dead pid", async () => {
    writeLock(2_147_483_646, Date.now());
    setApiKey("openrouter", "sk-recovered");
    expect(getApiKey("openrouter")).toBe("sk-recovered");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("recovers a credential lock whose mtime is older than 60s", () => {
    writeLock(process.pid, Date.now());
    const stale = new Date(Date.now() - 90_000);
    utimesSync(lockPath(), stale, stale);
    setApiKey("openrouter", "sk-mtime");
    expect(getApiKey("openrouter")).toBe("sk-mtime");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("times out instead of stealing a live credential lock", async () => {
    writeLock(process.pid, Date.now());
    await expect(Promise.resolve().then(() => setApiKey("openrouter", "sk-blocked")))
      .rejects.toThrow(/Timed out waiting for the credential lock/);
    expect(existsSync(lockPath())).toBe(true);
    expect(getApiKey("openrouter")).toBeUndefined();
  }, { timeout: 20_000 });

  it("reports an expired refresh failure as an error and does not send the stale token", async () => {
    seedExpiredCodex("refresh-old", jwt("stale-account"));
    const urls: string[] = [];
    resetOAuthProvidersForTests({
      fetch: (async () => { throw new Error("token endpoint down"); }) as typeof fetch,
    });
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return new Response("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n");
    }) as typeof fetch;
    const events: StreamEvent[] = [];
    for await (const event of streamLlmResponse({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "hi" }],
    })) events.push(event);
    expect(urls).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    const error = events[0];
    expect(error?.type === "error" && error.retryable).toBe(false);
    expect(error?.type === "error" && error.error.name).toBe("OAuthRefreshError");
    expect(error?.type === "error" && error.error.message).toBe(
      "OpenAI Codex session expired and could not be refreshed: token endpoint down. Run /login openai-codex again.",
    );
  });

  it("keeps using an unexpired token when refresh fails and warns", async () => {
    const access = jwt("still-good");
    setOAuthToken("openai-codex", {
      access,
      refresh: "refresh-soon",
      expires: Date.now() + 30_000,
      accountId: "still-good",
    });
    const urls: string[] = [];
    resetOAuthProvidersForTests({
      fetch: (async () => { throw new Error("temporary outage"); }) as typeof fetch,
    });
    globalThis.fetch = (async (url, init) => {
      urls.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${access}`);
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
    }) as typeof fetch;
    const events: StreamEvent[] = [];
    for await (const event of streamLlmResponse({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "hi" }],
    })) events.push(event);
    expect(urls).toEqual(["https://chatgpt.com/backend-api/codex/responses"]);
    expect(events.at(-1)?.type).toBe("done");
    expect(warnings.join("\n")).toContain("temporary outage");
    expect(warnings.join("\n")).toContain("using the current access token");
  });

  it("shows the re-login message from a turn when refresh of an expired token fails", async () => {
    seedExpiredCodex("refresh-old", jwt("stale-account"));
    let chatCalls = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { throw new Error("token endpoint down"); }) as typeof fetch,
    });
    globalThis.fetch = (async () => {
      chatCalls += 1;
      throw new Error("stale token was sent");
    }) as typeof fetch;
    const logDir = join(praanaHome, "sessions");
    mkdirSync(logDir, { recursive: true });
    const config = {
      llm: { provider: "openai-codex", model: "gpt-6.1-sol" },
      memory: { enabled: false, summarizer: "disabled", db_path: join(praanaHome, "memory.db") },
      compiler: { token_budget: 100_000, recent_turns: 2, recent_turns_token_budget: 8_000 },
      tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
      session: { log_dir: logDir },
      shell: { enabled: false, allowed_paths: [] },
      edit: { confirm: false },
      skills: { enabled: false, max_token_budget_ratio: 0.2, max_loaded_skills: 1, stale_threshold_turns: 10, max_depth: 1 },
      context_engine: { enabled: false },
    } as PraanaConfig;
    const session = await Session.create(praanaHome, config, { incognito: true });
    const fallbacks: string[] = [];
    try {
      const text = await runTurn(session, "hello", undefined, {
        sink: { onFallback: (line) => { fallbacks.push(line); } },
      });
      expect(chatCalls).toBe(0);
      expect(text).toContain("Run /login openai-codex again");
      expect(fallbacks.join("\n")).toContain("token endpoint down");
    } finally {
      await session.end("clean", [], { memoryTimeoutMs: 1 });
    }
  });
});

describe("credential refresh across processes", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-oauth-procs-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("unexpected network call"); }) as typeof fetch;
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests();
    globalThis.fetch = originalFetch;
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("refreshes once across two processes and keeps the file valid", async () => {
    seedExpiredCodex();
    setApiKey("openrouter", "sk-keep");
    const next = jwt("shared-account");
    let posts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        posts += 1;
        await Bun.sleep(200);
        return Response.json(tokenJson(next, "refresh-shared"));
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "praana-refresh-workers-"));
    const repo = join(import.meta.dir, "..");
    const script = join(dir, "worker.ts");
    writeFileSync(script, `
      import { writeFileSync, readdirSync } from "node:fs";
      import { join } from "node:path";
      import { resolveOAuthModelAuth, resetOAuthProvidersForTests } from ${JSON.stringify(pathToFileURL(join(repo, "src/oauth.ts")).href)};
      const originalFetch = globalThis.fetch.bind(globalThis);
      resetOAuthProvidersForTests({
        fetch: (async (_url, init) => originalFetch(process.env.REFRESH_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: init?.body,
        })) as typeof fetch,
      });
      const barrier = process.env.BARRIER_DIR;
      writeFileSync(join(barrier, process.env.WORKER_ID + ".ready"), "1");
      const deadline = Date.now() + 15_000;
      while (readdirSync(barrier).filter((name) => name.endsWith(".ready")).length < 2) {
        if (Date.now() > deadline) throw new Error("barrier timeout");
        await Bun.sleep(10);
      }
      try {
        const auth = await resolveOAuthModelAuth("openai-codex");
        writeFileSync(process.env.RESULT_FILE, JSON.stringify({ ok: true, apiKey: auth?.apiKey ?? null }));
      } catch (err) {
        writeFileSync(process.env.RESULT_FILE, JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        process.exitCode = 1;
      }
    `);
    const children: ChildProcess[] = [];
    try {
      const exits = ["a", "b"].map((id) => {
        const child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            PRAANA_HOME: praanaHome,
            REFRESH_URL: `http://127.0.0.1:${server.port}/refresh`,
            BARRIER_DIR: dir,
            WORKER_ID: id,
            RESULT_FILE: join(dir, `${id}.json`),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        return waitExit(child);
      });
      const finished = await Promise.all(exits);
      for (const result of finished) {
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      }
      const results = ["a", "b"].map((id) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { apiKey: string });
      expect(posts).toBe(1);
      expect(results.map((result) => result.apiKey)).toEqual([next, next]);
      const raw = readFileSync(getCredentialsFilePath(), "utf8");
      const stored = JSON.parse(raw) as {
        "openai-codex": { access: string; refresh: string };
        openrouter: { key: string };
      };
      expect(stored["openai-codex"]).toMatchObject({ access: next, refresh: "refresh-shared" });
      expect(stored.openrouter.key).toBe("sk-keep");
      expect(statSync(getCredentialsFilePath()).mode & 0o777).toBe(0o600);
    } finally {
      for (const child of children) child.kill();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 20_000 });
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("seeded credential interleaving", () => {
  let root: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-oauth-seeds-"));
    prevHome = process.env.PRAANA_HOME;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("unexpected network call"); }) as typeof fetch;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests();
    globalThis.fetch = originalFetch;
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  });

  async function runSeed(seed: number): Promise<void> {
    const home = mkdtempSync(join(root, "seed-"));
    process.env.PRAANA_HOME = home;
    resetCredentialStoreForTests();
    const rand = mulberry32(seed);
    const posts: string[] = [];
    resetOAuthProvidersForTests({
      fetch: (async (_url, init) => {
        const body = init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        const refresh = body.get("refresh_token") ?? "";
        posts.push(refresh);
        const pauses = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < pauses; i++) await Promise.resolve();
        return Response.json(tokenJson(jwt(`rot-${refresh}`), `next-${refresh}-${posts.length}`));
      }) as typeof fetch,
    });
    setOAuthToken("openai-codex", {
      access: jwt("seed-account"),
      refresh: "rt-seed",
      expires: Date.now() - 1_000,
      accountId: "seed-account",
    });
    const providers = ["openai-codex", "anthropic", "openrouter"] as const;
    const events: Array<{ provider: string; kind: "api" | "login" | "logout" }> = [];
    const values = new Map<string, string>();
    await Promise.all(Array.from({ length: 6 }, async (_, worker) => {
      for (let step = 0; step < 8; step++) {
        const pauses = Math.floor(rand() * 3);
        for (let i = 0; i < pauses; i++) await Promise.resolve();
        const roll = rand();
        const provider = providers[Math.floor(rand() * providers.length)]!;
        if (roll < 0.34) {
          await resolveOAuthModelAuth("openai-codex");
        } else if (roll < 0.56) {
          const key = `k-${seed}-${worker}-${step}`;
          setApiKey(provider, key);
          values.set(`${events.length}`, key);
          events.push({ provider, kind: "api" });
        } else if (roll < 0.78) {
          const access = jwt(`login-${seed}-${worker}-${step}`);
          setOAuthToken(provider, {
            access,
            refresh: `login-rt-${seed}-${worker}-${step}`,
            expires: Date.now() + 3_600_000,
            accountId: `login-${seed}-${worker}-${step}`,
          });
          values.set(`${events.length}`, access);
          events.push({ provider, kind: "login" });
        } else {
          removeCredentials(provider);
          events.push({ provider, kind: "logout" });
        }
        JSON.parse(readFileSync(getCredentialsFilePath(), "utf8"));
      }
    }));
    const counts = new Map<string, number>();
    for (const refresh of posts) counts.set(refresh, (counts.get(refresh) ?? 0) + 1);
    for (const [refresh, count] of counts) {
      if (count > 1) throw new Error(`refresh token ${refresh} was posted ${count} times`);
    }
    const last = new Map<string, { kind: "api" | "login" | "logout"; index: number }>();
    events.forEach((event, index) => last.set(event.provider, { kind: event.kind, index }));
    const stored = JSON.parse(readFileSync(getCredentialsFilePath(), "utf8")) as Record<string, { key?: string; access?: string }>;
    for (const [provider, event] of last) {
      if (event.kind === "logout") {
        if (provider in stored) throw new Error(`logged-out ${provider} reappeared`);
      } else if (event.kind === "api") {
        if (stored[provider]?.key !== values.get(String(event.index))) {
          throw new Error(`lost api key for ${provider}`);
        }
      } else if (stored[provider]?.access !== values.get(String(event.index))) {
        throw new Error(`lost login for ${provider}`);
      }
    }
    expect(statSync(getCredentialsFilePath()).mode & 0o777).toBe(0o600);
  }

  it("holds credential invariants for 300 seeded interleavings", async () => {
    const failed: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      try {
        await runSeed(seed);
      } catch (err) {
        failed.push(`${seed}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`${failed.length}/300 seeds failed\n${failed.slice(0, 8).join("\n")}`);
    }
  }, { timeout: 60_000 });
});
