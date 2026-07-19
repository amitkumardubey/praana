import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  getApiKey,
  setApiKey,
  removeApiKey,
  hasApiKey,
  listStoredProviders,
  resolveApiKey,
  getCredentialsFilePath,
  ensureCredentialsFileMode,
  resetCredentialStoreForTests,
} from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

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
});
