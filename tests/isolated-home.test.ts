import { describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { appHomePath } from "../src/app-identity.js";
import { providerEnvKeyNames } from "./helpers/provider-env-keys.js";
import {
  ISOLATED_HOME_GLOBAL_KEY,
  type IsolatedHomeInfo,
} from "./helpers/isolated-home.js";

/** Credential vars the isolation must clear even though no registry entry names them. */
const EXTRA_CREDENTIAL_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "COPILOT_GITHUB_TOKEN",
  "PGS_API_KEY",
];

function isolationInfo(): IsolatedHomeInfo {
  const info = (globalThis as unknown as Record<string, IsolatedHomeInfo | undefined>)[
    ISOLATED_HOME_GLOBAL_KEY
  ];
  if (!info) {
    throw new Error("tests/helpers/isolated-home.ts preload did not run");
  }
  return info;
}

/** True when `child` is `parent` or sits underneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const info = isolationInfo();

// PRAANA_TEST_REAL_HOME=1 disables the preload isolation on purpose, so there
// is nothing to assert in that mode.
describe.skipIf(!info.isolated)("isolated test home", () => {
  it("runs with HOME, USERPROFILE and PRAANA_HOME inside a per-run temp dir", () => {
    expect(info.isolated).toBe(true);
    expect(info.tempDir).not.toBeNull();

    expect(process.env.HOME).toBe(info.home);
    expect(process.env.USERPROFILE).toBe(info.home);
    expect(process.env.PRAANA_HOME).toBe(info.praanaHome);

    // The temp dir is a real directory under os.tmpdir(), one per run.
    expect(isWithin(tmpdir(), info.home)).toBe(true);
    expect(basename(info.home).startsWith("praana-test-home-")).toBe(true);
    expect(existsSync(info.home)).toBe(true);
    expect(statSync(info.home).isDirectory()).toBe(true);

    // PRAANA_HOME lives inside it, never at the real home.
    expect(isWithin(info.home, info.praanaHome)).toBe(true);
  });

  it("points at the temp dir, not the developer's real home", () => {
    const realPraanaHome = join(info.realHome, ".praana");

    expect(info.realHome).not.toBe("");
    expect(info.home).not.toBe(info.realHome);
    expect(isWithin(info.realHome, info.home)).toBe(false);
    expect(isWithin(info.realHome, info.praanaHome)).toBe(false);
    expect(isWithin(realPraanaHome, info.home)).toBe(false);
    expect(isWithin(realPraanaHome, info.praanaHome)).toBe(false);

    // The effective app home (~/.praana unless PRAANA_HOME overrides it) is
    // the temp one too, so nothing can resolve into the real credential store.
    const appHome = appHomePath();
    expect(isWithin(info.home, appHome)).toBe(true);
    expect(isWithin(realPraanaHome, appHome)).toBe(false);
    expect(isWithin(info.realHome, appHome)).toBe(false);

    // Bun caches os.homedir() from the HOME it started with, so homedir()
    // still reports the real home. That is why the preload re-applies the
    // isolated HOME before every test: a suite that unsets PRAANA_HOME must
    // not fall back to the real ~/.praana.
    expect(homedir()).toBe(info.realHome);
  });

  it("unsets every provider credential env var", () => {
    for (const key of providerEnvKeyNames()) {
      expect(process.env[key]).toBeUndefined();
    }
    for (const key of EXTRA_CREDENTIAL_ENV_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });
});
