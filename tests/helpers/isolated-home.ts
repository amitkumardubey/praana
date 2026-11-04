/**
 * Isolate the whole test suite from the developer's real home directory.
 *
 * Without this, `bun test` reads the real `~/.praana` credential store and the
 * real provider env vars (`OPENAI_API_KEY`, …). On a machine where a key is
 * exported, tests such as the model-listing and interactive-setup suites see a
 * configured provider: they take the "already logged in" branch or try to reach
 * the network, so the suite only passes with a hand-made isolated `HOME`.
 *
 * This module is listed in `bunfig.toml` `[test] preload` (after
 * `tests/helpers/solid-client.ts`) so it runs before any test module is loaded.
 * It creates one temp dir per run (`mkdtemp` under `os.tmpdir()`) and points
 * `HOME`, `USERPROFILE` and `PRAANA_HOME` at it, then removes provider
 * credential env vars. `src/app-identity.ts` appends `.praana` to
 * `PRAANA_HOME`, so `PRAANA_HOME=<tmp>/.praana` yields the effective home
 * `<tmp>/.praana/.praana` — both inside the temp dir, never the real home.
 *
 * The temp dir is deleted on process exit. Tests that set their own
 * `HOME`/`PRAANA_HOME` keep working: they override these values and restore
 * whatever they found (now the temp paths) when they finish.
 *
 * The isolation is also re-applied before every test. Some suites unset
 * `PRAANA_HOME` in cleanup instead of restoring it, and Bun caches
 * `os.homedir()` from the `HOME` it started with — so without the per-test
 * reset the next file would read `~/.praana` of the real home again.
 *
 * `PRAANA_TEST_REAL_HOME=1` opts out (for a rare test that needs the real
 * home); everything below is then a no-op.
 */
import { beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerEnvKeyNames } from "./provider-env-keys.js";

/**
 * Credential env vars the provider registry cannot know about: the AWS
 * credential chain (Bedrock), Google ADC, and misc API keys.
 */
const EXTRA_CREDENTIAL_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "PGS_API_KEY",
];

/** Global key the test suite reads to inspect what the preload did. */
export const ISOLATED_HOME_GLOBAL_KEY = "__PRAANA_TEST_ISOLATED_HOME__";

export interface IsolatedHomeInfo {
  /** Home directory the process started with (the developer's real home). */
  realHome: string;
  /** HOME in effect for the run. */
  home: string;
  /** PRAANA_HOME in effect for the run. */
  praanaHome: string;
  /** False when PRAANA_TEST_REAL_HOME=1 opted out. */
  isolated: boolean;
  /** Temp dir backing the isolation, or null when opted out. */
  tempDir: string | null;
}

function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

const realHome = envValue("HOME") || envValue("USERPROFILE");
const isolated = envValue("PRAANA_TEST_REAL_HOME") !== "1";

let tempDir: string | null = null;
let home = envValue("HOME");
let praanaHome = envValue("PRAANA_HOME");

if (isolated) {
  tempDir = mkdtempSync(join(tmpdir(), "praana-test-home-"));
  home = tempDir;
  praanaHome = join(tempDir, ".praana");
  mkdirSync(praanaHome, { recursive: true });

  const credentialEnvKeys = [...providerEnvKeyNames(), ...EXTRA_CREDENTIAL_ENV_KEYS];
  const applyIsolation = (): void => {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PRAANA_HOME = praanaHome;
    for (const key of credentialEnvKeys) delete process.env[key];
  };

  applyIsolation();
  beforeEach(applyIsolation);

  const dir = tempDir;
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a stray file lock must not fail the test run.
    }
  });
}

const info: IsolatedHomeInfo = { realHome, home, praanaHome, tempDir, isolated };
(globalThis as unknown as Record<string, IsolatedHomeInfo>)[ISOLATED_HOME_GLOBAL_KEY] = info;
