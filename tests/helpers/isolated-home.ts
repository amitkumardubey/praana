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
 * The isolation is also re-applied before and after every test. Some suites
 * unset `PRAANA_HOME` in cleanup instead of restoring it, and Bun caches
 * `os.homedir()` from the `HOME` it started with — so without the per-test
 * reset the next file (or a timer that outlives its test) would read
 * `~/.praana` of the real home again.
 *
 * The ONNX weight cache is shared between runs (`<tmpdir>/praana-test-model-
 * cache`) and warmed before the tests start: a cold home made the embedder
 * download ~23 MB from HuggingFace inside whichever test needed it first, and
 * `native-status` only allows 5s.
 *
 * `PRAANA_TEST_REAL_HOME=1` opts out (for a rare test that needs the real
 * home); everything below is then a no-op.
 */
import { afterAll, afterEach, beforeEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appHomePath } from "../../src/app-identity.js";
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

/** Preset the app downloads for `embedder = "auto"` (see src/memory/transformers-models.ts). */
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MODEL_FILES = ["tokenizer.json", "onnx/model_quantized.onnx"];

/** Best effort: fetch the default ONNX weights into the shared cache. */
async function prewarmModelCache(cacheDir: string): Promise<void> {
  const modelDir = join(cacheDir, MODEL_ID);
  if (MODEL_FILES.every((rel) => existsSync(join(modelDir, rel)))) return;

  // Capture the real fetch: tests replace globalThis.fetch with spies.
  const realFetch = globalThis.fetch;
  const signal = AbortSignal.timeout(30_000);
  try {
    for (const rel of MODEL_FILES) {
      const dest = join(modelDir, rel);
      if (existsSync(dest)) continue;
      const res = await realFetch(
        `https://huggingface.co/${MODEL_ID}/resolve/main/${rel}`,
        { signal },
      );
      if (!res.ok) return;
      const body = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(`${dest}.tmp`, body);
      renameSync(`${dest}.tmp`, dest);
    }
  } catch {
    // Offline or slow network: leave the cache cold, tests behave as before.
  }
}

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
  // Restore the isolated env after every test too: async work started by a test
  // (session-end consolidation, log flushes) can land in the gap after its own
  // afterEach deleted PRAANA_HOME, and would then write to the real home.
  afterEach(applyIsolation);

  // Share one ONNX weight cache between runs and warm it before the tests:
  // a cold home makes the embedder download inside whichever test needs it
  // first, and `native-status` only allows 5s for that probe.
  const modelCacheDir = join(tmpdir(), "praana-test-model-cache");
  const modelsPath = appHomePath("models");
  mkdirSync(modelCacheDir, { recursive: true });
  mkdirSync(appHomePath(), { recursive: true });
  try {
    symlinkSync(modelCacheDir, modelsPath, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  await prewarmModelCache(modelCacheDir);

  const dir = tempDir;
  let removed = false;
  const cleanup = (): void => {
    if (removed) return;
    removed = true;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a stray file lock must not fail the test run.
    }
  };
  // `bun test` does not emit process exit events, so the run-level afterAll
  // is what actually removes the temp dir; the exit hook covers other runners.
  afterAll(cleanup);
  process.once("exit", cleanup);
}

const info: IsolatedHomeInfo = { realHome, home, praanaHome, tempDir, isolated };
(globalThis as unknown as Record<string, IsolatedHomeInfo>)[ISOLATED_HOME_GLOBAL_KEY] = info;
