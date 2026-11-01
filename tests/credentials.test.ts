import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  getApiKey,
  setApiKey,
  removeApiKey,
  removeCredentials,
  hasApiKey,
  hasOAuthToken,
  hasCredentials,
  getOAuthToken,
  setOAuthToken,
  listStoredProviders,
  resolveApiKey,
  resolveAuth,
  getCredentialsFilePath,
  ensureCredentialsFileMode,
  mutateCredentialsForTests,
  failNextCredentialPersistForTests,
  readCachedOAuthIfUnchanged,
  resetCredentialStoreForTests,
  type StoredOAuthCredential,
} from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

function sampleOAuth(overrides?: Partial<StoredOAuthCredential>): StoredOAuthCredential {
  return {
    type: "oauth",
    access: "sk-ant-oat-access",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    savedAt: Date.now(),
    ...overrides,
  };
}

describe("credential store", () => {
  let praanaHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-creds-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("stores and retrieves a key by provider id", () => {
    setApiKey("my-provider", "sk-test-123");
    expect(getApiKey("my-provider")).toBe("sk-test-123");
  });

  it("trims whitespace when storing api keys", () => {
    setApiKey("my-provider", "  sk-test-123\n");
    expect(getApiKey("my-provider")).toBe("sk-test-123");
  });

  it("returns undefined for unknown provider", () => {
    expect(getApiKey("unknown")).toBeUndefined();
  });

  it("overwrites existing key on re-set", () => {
    setApiKey("my-provider", "sk-old");
    setApiKey("my-provider", "sk-new");
    expect(getApiKey("my-provider")).toBe("sk-new");
  });

  it("removes a key and returns true", () => {
    setApiKey("my-provider", "sk-test");
    expect(removeApiKey("my-provider")).toBe(true);
    expect(getApiKey("my-provider")).toBeUndefined();
  });

  it("returns false when removing non-existent key", () => {
    expect(removeApiKey("never-set")).toBe(false);
  });

  it("checks key existence with hasApiKey", () => {
    expect(hasApiKey("my-provider")).toBe(false);
    setApiKey("my-provider", "sk-test");
    expect(hasApiKey("my-provider")).toBe(true);
  });

  it("lists all providers with stored keys", () => {
    setApiKey("provider-a", "key-a");
    setApiKey("provider-b", "key-b");
    const providers = listStoredProviders().sort();
    expect(providers).toEqual(["provider-a", "provider-b"]);
  });

  it("persists across cache resets (writes to disk)", () => {
    setApiKey("persisted", "sk-persist");
    resetCredentialStoreForTests();
    expect(getApiKey("persisted")).toBe("sk-persist");
  });

  it("creates file with 0o600 permissions on Unix", () => {
    setApiKey("perm-test", "sk-perm");
    const credPath = getCredentialsFilePath();
    expect(existsSync(credPath)).toBe(true);
    const stat = statSync(credPath);
    // Owner-only permissions (group/other bits should be 0).
    expect(stat.mode & 0o077).toBe(0);
  });

  it("handles empty credential file gracefully", () => {
    setApiKey("first", "key-1");
    resetCredentialStoreForTests();
    // After reset, re-reading from disk should work.
    expect(getApiKey("first")).toBe("key-1");
    // Adding more keys should not lose existing ones.
    setApiKey("second", "key-2");
    resetCredentialStoreForTests();
    expect(getApiKey("first")).toBe("key-1");
    expect(getApiKey("second")).toBe("key-2");
  });

  it("treats array JSON as empty store", () => {
    const credPath = getCredentialsFilePath();
    mkdirSync(dirname(credPath), { recursive: true });
    writeFileSync(credPath, "[]", "utf-8");
    resetCredentialStoreForTests();
    expect(getApiKey("anything")).toBeUndefined();
    setApiKey("recovered", "sk-ok");
    expect(getApiKey("recovered")).toBe("sk-ok");
  });

  it("ensureCredentialsFileMode heals overly permissive files", () => {
    setApiKey("perm-heal", "sk-heal");
    const credPath = getCredentialsFilePath();
    chmodSync(credPath, 0o644);
    expect(statSync(credPath).mode & 0o077).not.toBe(0);
    ensureCredentialsFileMode();
    expect(statSync(credPath).mode & 0o077).toBe(0);
  });

  it("stores and retrieves oauth token bundles", () => {
    const bundle = sampleOAuth({ enterpriseUrl: "https://github.example.com" });
    setOAuthToken("github-copilot", bundle);
    expect(hasOAuthToken("github-copilot")).toBe(true);
    expect(hasApiKey("github-copilot")).toBe(false);
    expect(hasCredentials("github-copilot")).toBe(true);
    const stored = getOAuthToken("github-copilot");
    expect(stored?.access).toBe("sk-ant-oat-access");
    expect(stored?.refresh).toBe("refresh-token");
    expect(stored?.enterpriseUrl).toBe("https://github.example.com");
  });

  it("persists oauth bundles across cache resets", () => {
    setOAuthToken("openai-codex", sampleOAuth({ access: "codex-access" }));
    resetCredentialStoreForTests();
    expect(getOAuthToken("openai-codex")?.access).toBe("codex-access");
  });

  it("loads legacy key entries without type as api keys", () => {
    const credPath = getCredentialsFilePath();
    mkdirSync(dirname(credPath), { recursive: true });
    writeFileSync(
      credPath,
      JSON.stringify({ legacy: { key: "sk-legacy", savedAt: 1 } }),
      "utf-8",
    );
    resetCredentialStoreForTests();
    expect(getApiKey("legacy")).toBe("sk-legacy");
    expect(hasCredentials("legacy")).toBe(true);
  });

  it("ignores malformed oauth entries", () => {
    const credPath = getCredentialsFilePath();
    mkdirSync(dirname(credPath), { recursive: true });
    writeFileSync(
      credPath,
      JSON.stringify({
        bad: { type: "oauth", access: "", refresh: "r", expires: 1 },
      }),
      "utf-8",
    );
    resetCredentialStoreForTests();
    expect(getOAuthToken("bad")).toBeUndefined();
    expect(hasCredentials("bad")).toBe(false);
  });

  it("removeCredentials clears oauth bundles", () => {
    setOAuthToken("anthropic", sampleOAuth());
    expect(removeCredentials("anthropic")).toBe(true);
    expect(hasOAuthToken("anthropic")).toBe(false);
    expect(removeApiKey("anthropic")).toBe(false);
  });

  it("setApiKey replaces an oauth entry and setOAuthToken replaces a key", () => {
    setOAuthToken("anthropic", sampleOAuth());
    setApiKey("anthropic", "sk-ant-api");
    expect(hasOAuthToken("anthropic")).toBe(false);
    expect(getApiKey("anthropic")).toBe("sk-ant-api");
    setOAuthToken("anthropic", sampleOAuth({ access: "sk-ant-oat-new" }));
    expect(getApiKey("anthropic")).toBeUndefined();
    expect(getOAuthToken("anthropic")?.access).toBe("sk-ant-oat-new");
  });

  it("lists providers with oauth or api keys", () => {
    setApiKey("openrouter", "sk-or");
    setOAuthToken("openai-codex", sampleOAuth());
    expect(listStoredProviders().sort()).toEqual(["openai-codex", "openrouter"]);
  });

  it("resolveApiKey and resolveAuth return oauth access tokens", () => {
    setOAuthToken("openai-codex", sampleOAuth({ access: "codex-token" }));
    expect(resolveApiKey("openai-codex")).toBe("codex-token");
    expect(resolveAuth("openai-codex")).toEqual({
      kind: "oauth",
      apiKey: "codex-token",
      expires: expect.any(Number),
    });
  });

  it("re-reads when a replacement file keeps the same mtime", () => {
    setOAuthToken("openai-codex", sampleOAuth({ access: "old-access", refresh: "old-refresh" }));
    const path = getCredentialsFilePath();
    expect(readCachedOAuthIfUnchanged("openai-codex")).toMatchObject({
      unchanged: true,
      token: { access: "old-access" },
    });
    const before = statSync(path);
    const tmp = `${path}.next`;
    writeFileSync(tmp, JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 60_000,
        savedAt: 1,
      },
    }), { mode: 0o600 });
    renameSync(tmp, path);
    const seconds = before.mtimeMs / 1000;
    utimesSync(path, seconds, seconds);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(path).ino).not.toBe(before.ino);
    expect(readCachedOAuthIfUnchanged("openai-codex").unchanged).toBe(false);
  });

  it("does not replace a credentials file it cannot read", () => {
    const path = getCredentialsFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from("{\"openrouter\":{\"type\":\"api_key\",\"key\":\"sk-keep\",\"savedAt\":1}}");
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o000);
    resetCredentialStoreForTests();
    try {
      expect(() => setApiKey("openrouter", "sk-new")).toThrow(/left it unchanged/);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(dirname(path)).some((name) => name.startsWith("credentials.json.corrupt-"))).toBe(false);
  });
});

describe("resolveApiKey precedence", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-resolve-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete savedEnv[k];
    }
  });

  it("returns stored key when available (store > env)", () => {
    savedEnv.MY_KEY = process.env.MY_KEY;
    process.env.MY_KEY = "env-value";
    setApiKey("provider-x", "stored-value");
    expect(resolveApiKey("provider-x", "MY_KEY")).toBe("stored-value");
  });

  it("falls back to env var when no stored key", () => {
    savedEnv.MY_KEY = process.env.MY_KEY;
    process.env.MY_KEY = "env-value";
    expect(resolveApiKey("provider-y", "MY_KEY")).toBe("env-value");
  });

  it("returns 'no-key' sentinel when no key anywhere and no envKey", () => {
    expect(resolveApiKey("keyless-provider")).toBe("no-key");
  });

  it("returns empty string when envKey provided but env var unset and no stored key", () => {
    savedEnv.UNSET_KEY = process.env.UNSET_KEY;
    delete process.env.UNSET_KEY;
    expect(resolveApiKey("provider-z", "UNSET_KEY")).toBe("");
  });

  it("a throwing mutator leaves the credential cache and file unchanged", () => {
    setOAuthToken("openai-codex", {
      access: "access-1",
      refresh: "refresh-1",
      expires: 123,
      accountId: "acct",
    });
    const before = readFileSync(getCredentialsFilePath());
    const cached = getOAuthToken("openai-codex");
    expect(cached?.access).toBe("access-1");
    expect(() => mutateCredentialsForTests((creds) => {
      const entry = creds["openai-codex"];
      if (entry && entry.type === "oauth") entry.access = "mutated";
      throw new Error("boom");
    })).toThrow("boom");
    expect(readFileSync(getCredentialsFilePath())).toEqual(before);
    expect(getOAuthToken("openai-codex")?.access).toBe("access-1");
    expect(getOAuthToken("openai-codex")?.refresh).toBe("refresh-1");
  });

  it("a throwing mutator on a corrupt credentials file leaves the file and cache unchanged", () => {
    setApiKey("openrouter", "sk-keep");
    const path = getCredentialsFilePath();
    const bytes = Buffer.from("{not-json");
    writeFileSync(path, bytes);
    expect(() => mutateCredentialsForTests(() => {
      throw new Error("boom");
    })).toThrow("boom");
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(dirname(path)).some((name) => name.includes(".corrupt-"))).toBe(false);
    expect(getApiKey("openrouter")).toBe("sk-keep");
  });

  it("a failed save of a corrupt credentials file leaves the original file and cache unchanged", () => {
    setApiKey("openrouter", "sk-keep");
    const path = getCredentialsFilePath();
    const bytes = Buffer.from("{not-json");
    writeFileSync(path, bytes, { mode: 0o600 });
    const error = new Error("no space left on device");
    (error as NodeJS.ErrnoException).code = "ENOSPC";
    failNextCredentialPersistForTests(error);
    expect(() => mutateCredentialsForTests((creds) => {
      creds["openrouter"] = { type: "api_key", key: "sk-new", savedAt: 1 };
    })).toThrow("no space left on device");
    expect(readFileSync(path)).toEqual(bytes);
    const backups = readdirSync(dirname(path)).filter((name) => name.startsWith("credentials.json.corrupt-"));
    expect(backups).toHaveLength(1);
    const backupPath = join(dirname(path), backups[0]!);
    expect(readFileSync(backupPath)).toEqual(bytes);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(path)).some((name) => name.includes(".tmp"))).toBe(false);
    expect(getApiKey("openrouter")).toBe("sk-keep");
  });
});
