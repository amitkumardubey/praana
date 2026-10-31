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
import { acquireAsync, acquireSync, CredentialLockTimeoutError, type CredentialLock } from "../src/credential-lock.js";
import {
  credentialDiskReadCountForTests,
  credentialLockPathForTests,
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
  setRefreshLockWaitMsForTests,
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

function holdLock(kind: "store" | "refresh", provider = "openai-codex"): CredentialLock {
  return acquireSync(credentialLockPathForTests(kind, provider), { waitMs: 0 });
}

function turnConfig(logDir: string, home: string): PraanaConfig {
  return {
    llm: { provider: "openai-codex", model: "gpt-6.1-sol" },
    memory: { enabled: false, summarizer: "disabled", db_path: join(home, "memory.db") },
    compiler: { token_budget: 100_000, recent_turns: 2, recent_turns_token_budget: 8_000 },
    tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
    session: { log_dir: logDir },
    shell: { enabled: false, allowed_paths: [] },
    edit: { confirm: false },
    skills: { enabled: false, max_token_budget_ratio: 0.2, max_loaded_skills: 1, stale_threshold_turns: 10, max_depth: 1 },
    context_engine: { enabled: true },
  } as PraanaConfig;
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
    const settled = pending.then(
      () => ({ aborted: false as const }),
      (err: unknown) => ({ aborted: true as const, err }),
    );
    await Bun.sleep(20);
    release(Response.json(tokenJson(next, "refresh-after-cancel")));
    const outcome = await settled;
    expect(outcome.aborted).toBe(true);
    if (outcome.aborted) expect(String(outcome.err)).toMatch(/abort/i);
    const deadline = Date.now() + 2_000;
    while (getOAuthToken("openai-codex")?.refresh !== "refresh-after-cancel") {
      if (Date.now() > deadline) break;
      await Bun.sleep(10);
    }
    expect(sawAbortedRequest).toBe(false);
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

  it("times out instead of stealing a live credential lock", async () => {
    const lock = holdLock("store");
    try {
      const started = Date.now();
      await expect(Promise.resolve().then(() => setApiKey("openrouter", "sk-blocked")))
        .rejects.toThrow(/Timed out waiting for the credential lock/);
      expect(Date.now() - started).toBeGreaterThan(1_500);
      expect(getApiKey("openrouter")).toBeUndefined();
    } finally {
      lock.release();
    }
  }, { timeout: 8_000 });

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
      context_engine: { enabled: true },
    } as PraanaConfig;
    const session = await Session.create(praanaHome, config, { incognito: true });
    const errors: string[] = [];
    const fallbacks: string[] = [];
    let postTurns = 0;
    session.hooks.onPostTurn(() => { postTurns += 1; });
    const turnsBefore = session.getTurnCount();
    try {
      const text = await runTurn(session, "hello", undefined, {
        sink: {
          onError: (entry) => { errors.push(entry.message); },
          onFallback: (line) => { fallbacks.push(line); },
        },
      });
      expect(chatCalls).toBe(0);
      expect(text).toContain("Run /login openai-codex again");
      expect(text).toContain("token endpoint down");
      expect(errors).toEqual([text.trim()]);
      expect(fallbacks).toEqual([]);
      expect(session.getTurnCount()).toBe(turnsBefore + 1);
      expect(postTurns).toBe(1);
      const messages = session.eventLog.readAll().filter((event) => event.kind === "agent_message");
      expect(messages).toHaveLength(1);
      expect(session.contextEngine).not.toBeNull();
      expect(session.contextEngine!.ledger.list().length).toBe(1);
    } finally {
      await session.end("clean", [], { memoryTimeoutMs: 1 });
    }
  });

  it("waits on a live refresh lock and does not start a second refresh", async () => {
    seedExpiredCodex();
    const refreshLock = holdLock("refresh");
    let posts = 0;
    const next = jwt("after-wait");
    resetOAuthProvidersForTests({
      fetch: (async () => {
        posts += 1;
        return Response.json(tokenJson(next, "refresh-after-wait"));
      }) as typeof fetch,
    });
    const pending = resolveOAuthModelAuth("openai-codex");
    const settled = pending.then(
      (auth) => ({ ok: true as const, auth }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    const state = await Promise.race([
      settled.then((result) => result.ok ? "done" as const : "failed" as const),
      Bun.sleep(400).then(() => "waiting" as const),
    ]);
    expect(state).toBe("waiting");
    expect(posts).toBe(0);
    refreshLock.release();
    const result = await settled;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(posts).toBe(1);
    expect(result.auth?.apiKey).toBe(next);
  });

  it("gives the rotated token to the caller that did not abort", async () => {
    seedExpiredCodex();
    const next = jwt("shared-abort");
    const aborted = new AbortController();
    let release!: (response: Response) => void;
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (() => {
        posts += 1;
        return new Promise<Response>((resolve) => { release = resolve; });
      }) as typeof fetch,
    });
    const first = resolveOAuthModelAuth("openai-codex", aborted.signal);
    const firstSettled = first.then(
      () => ({ aborted: false as const }),
      (err: unknown) => ({ aborted: true as const, err }),
    );
    const second = resolveOAuthModelAuth("openai-codex");
    await Bun.sleep(20);
    aborted.abort();
    release(Response.json(tokenJson(next, "refresh-shared-abort")));
    const firstOutcome = await firstSettled;
    expect(firstOutcome.aborted).toBe(true);
    if (firstOutcome.aborted) expect(String(firstOutcome.err)).toMatch(/abort/i);
    await expect(second).resolves.toMatchObject({ apiKey: next });
    expect(posts).toBe(1);
    expect(getOAuthToken("openai-codex")?.refresh).toBe("refresh-shared-abort");
  });

  it("persists the rotated token when every caller aborts", async () => {
    seedExpiredCodex();
    const next = jwt("both-abort");
    const firstCtl = new AbortController();
    const secondCtl = new AbortController();
    let release!: (response: Response) => void;
    resetOAuthProvidersForTests({
      fetch: (() => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch,
    });
    const first = resolveOAuthModelAuth("openai-codex", firstCtl.signal);
    const second = resolveOAuthModelAuth("openai-codex", secondCtl.signal);
    const settled = Promise.all([
      first.then(() => ({ aborted: false as const }), (err: unknown) => ({ aborted: true as const, err })),
      second.then(() => ({ aborted: false as const }), (err: unknown) => ({ aborted: true as const, err })),
    ]);
    await Bun.sleep(20);
    firstCtl.abort();
    secondCtl.abort();
    release(Response.json(tokenJson(next, "refresh-both-abort")));
    const [left, right] = await settled;
    expect(left.aborted).toBe(true);
    expect(right.aborted).toBe(true);
    if (left.aborted) expect(String(left.err)).toMatch(/abort/i);
    if (right.aborted) expect(String(right.err)).toMatch(/abort/i);
    const deadline = Date.now() + 2_000;
    while (getOAuthToken("openai-codex")?.refresh !== "refresh-both-abort") {
      if (Date.now() > deadline) break;
      await Bun.sleep(10);
    }
    expect(getOAuthToken("openai-codex")).toMatchObject({ access: next, refresh: "refresh-both-abort" });
  });

  it("refreshes two providers and keeps an api key written during both", async () => {
    seedExpiredCodex();
    setOAuthToken("anthropic", {
      access: "ant-old",
      refresh: "ant-old",
      expires: Date.now() - 1_000,
    });
    let releaseCodex!: (response: Response) => void;
    let releaseAnthropic!: () => void;
    const posts: string[] = [];
    resetOAuthProvidersForTests({
      fetch: (() => {
        posts.push("refresh-old");
        return new Promise<Response>((resolve) => { releaseCodex = resolve; });
      }) as typeof fetch,
    }, {
      anthropic: {
        name: "Anthropic",
        async login() { throw new Error("unused"); },
        async refresh(cred) {
          posts.push(cred.refresh);
          await new Promise<void>((resolve) => { releaseAnthropic = resolve; });
          return {
            type: "oauth",
            access: "ant-new",
            refresh: "ant-next",
            expires: Date.now() + 3_600_000,
          };
        },
        async toAuth(cred) { return { apiKey: cred.access }; },
      },
    });
    const codex = resolveOAuthModelAuth("openai-codex");
    const anthropic = resolveOAuthModelAuth("anthropic");
    const started = Date.now();
    while ((!releaseCodex || !releaseAnthropic) && Date.now() - started < 1_000) {
      await Bun.sleep(10);
    }
    expect(typeof releaseCodex).toBe("function");
    expect(typeof releaseAnthropic).toBe("function");
    setApiKey("openrouter", "sk-mid");
    const next = jwt("codex-mid");
    releaseAnthropic();
    releaseCodex(Response.json(tokenJson(next, "codex-next")));
    const [codexAuth, anthropicAuth] = await Promise.all([codex, anthropic]);
    expect(posts.filter((item) => item === "refresh-old")).toHaveLength(1);
    expect(posts.filter((item) => item === "ant-old")).toHaveLength(1);
    expect(codexAuth?.apiKey).toBe(next);
    expect(anthropicAuth?.apiKey).toBe("ant-new");
    resetCredentialStoreForTests();
    expect(getApiKey("openrouter")).toBe("sk-mid");
    expect(getOAuthToken("openai-codex")?.refresh).toBe("codex-next");
    expect(getOAuthToken("anthropic")?.refresh).toBe("ant-next");
  });

  it("does not hold the credential file lock across a refresh", async () => {
    seedExpiredCodex();
    const dir = mkdtempSync(join(tmpdir(), "praana-refresh-lockfree-"));
    const started = join(dir, "started");
    const script = join(dir, "write-other.ts");
    const repo = join(import.meta.dir, "..");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      import { setApiKey } from ${JSON.stringify(pathToFileURL(join(repo, "src/credentials.ts")).href)};
      writeFileSync(${JSON.stringify(started)}, "1");
      setApiKey("openrouter", "sk-during-refresh");
    `);
    const next = jwt("lockfree");
    let child: ChildProcess | undefined;
    resetOAuthProvidersForTests({
      fetch: (async () => {
        child = spawn(process.execPath, [script], {
          env: { ...process.env, PRAANA_HOME: praanaHome },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const exitP = waitExit(child);
        await waitForFile(started);
        const finished = await Promise.race([
          exitP.then(() => "done" as const),
          Bun.sleep(500).then(() => "blocked" as const),
        ]);
        if (finished === "blocked") {
          throw new Error("credential file lock was held across refresh");
        }
        return Response.json(tokenJson(next, "refresh-lockfree"));
      }) as typeof fetch,
    });
    try {
      const auth = await resolveOAuthModelAuth("openai-codex");
      expect(auth?.apiKey).toBe(next);
      resetCredentialStoreForTests();
      expect(getApiKey("openrouter")).toBe("sk-during-refresh");
    } finally {
      child?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not read the credential file for a non-OAuth provider", async () => {
    mkdirSync(join(getCredentialsFilePath(), ".."), { recursive: true });
    writeFileSync(getCredentialsFilePath(), "{", { mode: 0o600 });
    resetCredentialStoreForTests();
    warnings.length = 0;
    const reads = credentialDiskReadCountForTests();
    await expect(resolveOAuthModelAuth("openrouter")).resolves.toBeNull();
    await expect(resolveOAuthModelAuth("openai")).resolves.toBeNull();
    expect(warnings.join("\n")).not.toContain("Failed to read credentials store");
    expect(credentialDiskReadCountForTests()).toBe(reads);
  });

  it("does not re-read a fresh cached OAuth token", async () => {
    const access = jwt("fresh-cache");
    setOAuthToken("openai-codex", {
      access,
      refresh: "rt-fresh",
      expires: Date.now() + 3_600_000,
      accountId: "fresh-cache",
    });
    const reads = credentialDiskReadCountForTests();
    const first = await resolveOAuthModelAuth("openai-codex");
    const second = await resolveOAuthModelAuth("openai-codex");
    expect(first?.apiKey).toBe(access);
    expect(second?.apiKey).toBe(access);
    expect(credentialDiskReadCountForTests()).toBe(reads);
  });

  it("re-reads when the credentials file changes under a fresh cache", async () => {
    const access = jwt("cached-account");
    setOAuthToken("openai-codex", {
      access,
      refresh: "rt-cached",
      expires: Date.now() + 3_600_000,
      accountId: "cached-account",
    });
    const replacement = jwt("external-account");
    const stored = JSON.parse(readFileSync(getCredentialsFilePath(), "utf8")) as Record<string, { access: string }>;
    stored["openai-codex"]!.access = replacement;
    writeFileSync(getCredentialsFilePath(), JSON.stringify(stored), { mode: 0o600 });
    const auth = await resolveOAuthModelAuth("openai-codex");
    expect(auth?.apiKey).toBe(replacement);
  });

  it("reports a busy refresh instead of a session expiry when the refresh lock stays held", async () => {
    seedExpiredCodex();
    const refreshLock = holdLock("refresh");
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { posts += 1; throw new Error("should not refresh"); }) as typeof fetch,
    });
    setRefreshLockWaitMsForTests(200);
    try {
      await expect(resolveOAuthModelAuth("openai-codex")).rejects.toThrow(
        "another PRAANA session is refreshing; try again in a moment",
      );
      expect(posts).toBe(0);
      expect(getOAuthToken("openai-codex")?.refresh).toBe("refresh-old");
    } finally {
      refreshLock.release();
    }
  });

  it("keeps a still-valid token when the refresh lock wait runs out", async () => {
    const access = jwt("still-valid");
    setOAuthToken("openai-codex", {
      access,
      refresh: "rt-soon",
      expires: Date.now() + 30_000,
      accountId: "still-valid",
    });
    const refreshLock = holdLock("refresh");
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { posts += 1; throw new Error("should not refresh"); }) as typeof fetch,
    });
    setRefreshLockWaitMsForTests(200);
    try {
      const auth = await resolveOAuthModelAuth("openai-codex");
      expect(posts).toBe(0);
      expect(auth?.apiKey).toBe(access);
      expect(warnings.join("\n")).not.toContain("session expired");
      expect(warnings.join("\n")).toContain("using the current access token");
    } finally {
      refreshLock.release();
    }
  });

  it("waits a second time before reporting a busy refresh of an expired token", async () => {
    seedExpiredCodex();
    const refreshLock = holdLock("refresh");
    const next = jwt("after-second-wait");
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => {
        posts += 1;
        return Response.json(tokenJson(next, "refresh-after-second"));
      }) as typeof fetch,
    });
    setRefreshLockWaitMsForTests(200);
    const pending = resolveOAuthModelAuth("openai-codex").then(
      (auth) => ({ ok: true as const, auth }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    const state = await Promise.race([
      pending.then((result) => result.ok ? "done" as const : "failed" as const),
      Bun.sleep(280).then(() => "waiting" as const),
    ]);
    expect(state).toBe("waiting");
    refreshLock.release();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(posts).toBe(1);
    expect(result.auth?.apiKey).toBe(next);
    expect(getOAuthToken("openai-codex")?.refresh).toBe("refresh-after-second");
  });

  it("tells the caller to retry in a moment when both busy waits expire", async () => {
    seedExpiredCodex();
    const refreshLock = holdLock("refresh");
    let posts = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { posts += 1; throw new Error("should not refresh"); }) as typeof fetch,
    });
    setRefreshLockWaitMsForTests(40);
    try {
      await expect(resolveOAuthModelAuth("openai-codex")).rejects.toThrow(
        "another PRAANA session is refreshing; try again in a moment",
      );
      expect(posts).toBe(0);
      expect(getOAuthToken("openai-codex")?.refresh).toBe("refresh-old");
    } finally {
      refreshLock.release();
    }
  });

  it("does not surface a busy refresh from a turn when the access token is still valid", async () => {
    const access = jwt("turn-still-valid");
    setOAuthToken("openai-codex", {
      access,
      refresh: "rt-turn-valid",
      expires: Date.now() + 30_000,
      accountId: "turn-still-valid",
    });
    const refreshLock = holdLock("refresh");
    resetOAuthProvidersForTests({
      fetch: (async () => { throw new Error("should not refresh"); }) as typeof fetch,
    });
    setRefreshLockWaitMsForTests(40);
    globalThis.fetch = (async () => new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
    )) as typeof fetch;
    const logDir = join(praanaHome, "sessions");
    mkdirSync(logDir, { recursive: true });
    const session = await Session.create(praanaHome, turnConfig(logDir, praanaHome), { incognito: true });
    const errors: string[] = [];
    try {
      const text = await runTurn(session, "hello", undefined, {
        sink: { onError: (entry) => { errors.push(entry.message); } },
      });
      expect(text).toContain("hello");
      expect(text).not.toContain("Run /login");
      expect(text).not.toContain("try again in a moment");
      expect(errors.join("\n")).not.toContain("Run /login");
      expect(errors.join("\n")).not.toContain("refreshing");
    } finally {
      refreshLock.release();
      await session.end("clean", [], { memoryTimeoutMs: 1 });
    }
  });

  it("shows a retry-in-a-moment message from a turn when the refresh lock outlasts an expired token", async () => {
    seedExpiredCodex();
    const refreshLock = holdLock("refresh");
    let chatCalls = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { throw new Error("should not refresh"); }) as typeof fetch,
    });
    setRefreshLockWaitMsForTests(30);
    globalThis.fetch = (async () => {
      chatCalls += 1;
      throw new Error("stale token was sent");
    }) as typeof fetch;
    const logDir = join(praanaHome, "sessions");
    mkdirSync(logDir, { recursive: true });
    const session = await Session.create(praanaHome, turnConfig(logDir, praanaHome), { incognito: true });
    const errors: string[] = [];
    try {
      const text = await runTurn(session, "hello", undefined, {
        sink: { onError: (entry) => { errors.push(entry.message); } },
      });
      expect(chatCalls).toBe(0);
      expect(text).toContain("another PRAANA session is refreshing; try again in a moment");
      expect(text).not.toContain("Run /login");
      expect(errors).toEqual([text.trim()]);
    } finally {
      refreshLock.release();
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

  it("lets a second process use the rotated token without a second refresh", async () => {
    seedExpiredCodex();
    const next = jwt("waited-account");
    let posts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        posts += 1;
        await Bun.sleep(300);
        return Response.json(tokenJson(next, "refresh-waited"));
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "praana-refresh-waiters-"));
    const repo = join(import.meta.dir, "..");
    const script = join(dir, "worker.ts");
    writeFileSync(script, `
      import { existsSync, writeFileSync } from "node:fs";
      import { resolveOAuthModelAuth, resetOAuthProvidersForTests } from ${JSON.stringify(pathToFileURL(join(repo, "src/oauth.ts")).href)};
      const originalFetch = globalThis.fetch.bind(globalThis);
      resetOAuthProvidersForTests({
        fetch: (async (_url, init) => {
          if (process.env.HOLD_FILE) writeFileSync(process.env.HOLD_FILE, "1");
          return originalFetch(process.env.REFRESH_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: init?.body,
          });
        }) as typeof fetch,
      });
      if (process.env.WAIT_FILE) {
        const deadline = Date.now() + 15_000;
        while (!existsSync(process.env.WAIT_FILE)) {
          if (Date.now() > deadline) throw new Error("wait timeout");
          await Bun.sleep(10);
        }
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
      const first = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          PRAANA_HOME: praanaHome,
          REFRESH_URL: `http://127.0.0.1:${server.port}/refresh`,
          HOLD_FILE: join(dir, "holding"),
          RESULT_FILE: join(dir, "a.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(first);
      await waitForFile(join(dir, "holding"));
      const second = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          PRAANA_HOME: praanaHome,
          REFRESH_URL: `http://127.0.0.1:${server.port}/refresh`,
          WAIT_FILE: join(dir, "holding"),
          RESULT_FILE: join(dir, "b.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(second);
      const finished = await Promise.all([waitExit(first), waitExit(second)]);
      for (const result of finished) {
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      }
      const results = ["a", "b"].map((id) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { apiKey: string });
      expect(posts).toBe(1);
      expect(results.map((result) => result.apiKey)).toEqual([next, next]);
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
  let holderScript: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-oauth-seeds-"));
    prevHome = process.env.PRAANA_HOME;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("unexpected network call"); }) as typeof fetch;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
    holderScript = join(root, "hold-lock.ts");
    const lockUrl = pathToFileURL(join(import.meta.dir, "../src/credential-lock.ts")).href;
    writeFileSync(holderScript, `
      import { writeFileSync } from "node:fs";
      import { acquireSync } from ${JSON.stringify(lockUrl)};
      const handle = acquireSync(process.argv[2], { waitMs: 0 });
      (globalThis as { __lock?: unknown }).__lock = handle;
      writeFileSync(process.argv[3], "1");
      setInterval(() => {}, 1000);
    `);
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
    const recordRefresh = async (refresh: string) => {
      posts.push(refresh);
      const pauses = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < pauses; i++) await Promise.resolve();
      return `next-${refresh}-${posts.length}`;
    };
    resetOAuthProvidersForTests({
      fetch: (async (_url, init) => {
        const body = init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        const refresh = body.get("refresh_token") ?? "";
        const next = await recordRefresh(refresh);
        return Response.json(tokenJson(jwt(`rot-${refresh}`), next));
      }) as typeof fetch,
    }, {
      anthropic: {
        name: "Anthropic",
        async login() { throw new Error("unused"); },
        async refresh(cred) {
          const next = await recordRefresh(cred.refresh);
          return { type: "oauth", access: `ant-${next}`, refresh: next, expires: Date.now() + 3_600_000 };
        },
        async toAuth(cred) { return { apiKey: cred.access }; },
      },
    });
    setOAuthToken("openai-codex", {
      access: jwt("seed-account"),
      refresh: "rt-seed",
      expires: Date.now() - 1_000,
      accountId: "seed-account",
    });
    setOAuthToken("anthropic", {
      access: "ant-seed",
      refresh: "ant-seed",
      expires: Date.now() - 1_000,
    });
    const refreshPath = credentialLockPathForTests("refresh");
    const held = acquireSync(refreshPath, { waitMs: 0 });
    try {
      const aged = new Date(Date.now() - 90_000);
      utimesSync(refreshPath, aged, aged);
      let stolen: CredentialLock | undefined;
      try {
        stolen = await acquireAsync(refreshPath, { waitMs: 0, pollMs: 100 });
      } catch (err) {
        if (!(err instanceof CredentialLockTimeoutError)) throw err;
      }
      if (stolen) {
        stolen.release();
        throw new Error("live lock was taken over");
      }
      const ctl = new AbortController();
      const waiter = acquireAsync(refreshPath, { waitMs: 5_000, signal: ctl.signal, pollMs: 100 })
        .then(() => "acquired" as const, (err: unknown) => err);
      await Bun.sleep(20);
      ctl.abort();
      const aborted = await waiter;
      if (!(aborted instanceof Error) || aborted.name !== "AbortError") {
        throw new Error(`abort did not end only the waiter (${String(aborted)})`);
      }
    } finally {
      held.release();
    }
    const ready = join(home, "killed-ready");
    const child = spawn(process.execPath, [holderScript, refreshPath, ready], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childErr = "";
    child.stderr?.on("data", (chunk: Buffer) => { childErr += String(chunk); });
    try {
      await waitForFile(ready);
      child.kill("SIGKILL");
      const killed = await waitExit(child);
      if (killed.code !== null && killed.code !== 137 && killed.code !== 9) {
        throw new Error(`holder exited before SIGKILL (${killed.code}): ${childErr || killed.stderr}`);
      }
      const afterKill = acquireSync(refreshPath, { waitMs: 1_000 });
      afterKill.release();
    } catch (err) {
      child.kill("SIGKILL");
      throw new Error(`${err instanceof Error ? err.message : String(err)}${childErr ? `: ${childErr}` : ""}`);
    }
    const providers = ["openai-codex", "anthropic", "openrouter"] as const;
    const events: Array<{ provider: string; kind: "api" | "login" | "logout" }> = [];
    const values = new Map<string, string>();
    await Promise.all(Array.from({ length: 6 }, async (_, worker) => {
      for (let step = 0; step < 8; step++) {
        const pauses = Math.floor(rand() * 3);
        for (let i = 0; i < pauses; i++) await Promise.resolve();
        const roll = rand();
        const provider = providers[Math.floor(rand() * providers.length)]!;
        if (roll < 0.28) {
          const ctl = new AbortController();
          const pending = resolveOAuthModelAuth(rand() < 0.5 ? "openai-codex" : "anthropic", ctl.signal)
            .catch(() => {});
          if (rand() < 0.4) ctl.abort();
          await pending;
        } else if (roll < 0.48) {
          await Promise.all([
            resolveOAuthModelAuth("openai-codex").catch(() => {}),
            resolveOAuthModelAuth("anthropic").catch(() => {}),
          ]);
        } else if (roll < 0.66) {
          const key = `k-${seed}-${worker}-${step}`;
          setApiKey(provider, key);
          values.set(`${events.length}`, key);
          events.push({ provider, kind: "api" });
        } else if (roll < 0.84) {
          const access = provider === "openai-codex"
            ? jwt(`login-${seed}-${worker}-${step}`)
            : `login-${seed}-${worker}-${step}`;
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
    await resolveOAuthModelAuth("openai-codex").catch(() => {});
    await resolveOAuthModelAuth("anthropic").catch(() => {});
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
  }, { timeout: 240_000 });
});
