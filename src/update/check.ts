import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "../app-identity.js";
import { GITHUB_REPO_SLUG } from "./repo.js";
import { isNewer, normalizeVersionLabel } from "./semver.js";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 1500;
export const UPGRADE_CHECK_TIMEOUT_MS = 5000;
export const NPM_LATEST_URL = "https://registry.npmjs.org/praana/latest";
export const GITHUB_LATEST_URL =
  `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest`;

const CACHE_VERSION = 1;

export interface UpdateCheckCache {
  version: number;
  checkedAt: number;
  latestVersion: string;
  source: "npm";
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  available: boolean;
  fromCache: boolean;
}

export interface RefreshUpdateCheckOptions {
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  runMode?: boolean;
  ignoreSkip?: boolean;
  forceRefresh?: boolean;
  now?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function envOn(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = env[key]?.trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "off";
}

export function shouldSkipUpdateCheck(
  env: NodeJS.ProcessEnv = process.env,
  opts: { isTty?: boolean; runMode?: boolean } = {},
): boolean {
  if (envOn(env, "CI")) return true;
  if (envOn(env, "VITEST")) return true;
  if (env.NODE_ENV?.trim() === "test") return true;
  if (envOn(env, "PRAANA_NO_UPDATE_CHECK")) return true;
  if (opts.runMode) return true;
  if (opts.isTty === false) return true;
  return false;
}

export function getUpdateCheckPath(): string {
  return appHomePath("update-check.json");
}

export function formatUpdateNotice(current: string, latest: string): string {
  return `Update available: ${normalizeVersionLabel(current)} → ${normalizeVersionLabel(latest)} · praana upgrade`;
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
    throw err;
  }
}

export function readUpdateCheckCache(): UpdateCheckCache | null {
  const path = getUpdateCheckPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as UpdateCheckCache;
    if (
      raw.version === CACHE_VERSION &&
      typeof raw.checkedAt === "number" &&
      typeof raw.latestVersion === "string" &&
      raw.latestVersion.length > 0
    ) {
      return raw;
    }
  } catch {
    return null;
  }
  return null;
}

export function writeUpdateCheckCache(cache: UpdateCheckCache): void {
  atomicWriteJson(getUpdateCheckPath(), cache);
}

async function fetchNpmLatest(
  fetchImpl: typeof fetch,
  userAgent: string,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(NPM_LATEST_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0 ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function stableVersion(value: unknown): string | null {
  if (typeof value !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  return value.replace(/^v/, "");
}

async function fetchGithubLatest(
  fetchImpl: typeof fetch,
  userAgent: string,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GITHUB_LATEST_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": userAgent },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown; prerelease?: unknown; draft?: unknown };
    return body.prerelease || body.draft ? null : stableVersion(body.tag_name);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toResult(
  current: string,
  latest: string,
  fromCache: boolean,
): UpdateCheckResult {
  return {
    current,
    latest,
    available: isNewer(latest, current),
    fromCache,
  };
}

export async function refreshUpgradeCheck(opts: RefreshUpdateCheckOptions = {}): Promise<UpdateCheckResult | null> {
  const current = opts.currentVersion ?? "0.0.0";
  const timeoutMs = opts.timeoutMs ?? UPGRADE_CHECK_TIMEOUT_MS;
  const [npm, github] = await Promise.allSettled([
    refreshUpdateCheck({ ...opts, timeoutMs, ignoreSkip: true, forceRefresh: true }),
    fetchGithubLatest(opts.fetchImpl ?? fetch, `praana/${current}`, timeoutMs),
  ]);

  // GitHub is the source of truth: the installer downloads the latest GitHub
  // release, so its answer wins whenever it answers. npm is only a fallback.
  if (github.status === "fulfilled" && github.value) {
    return toResult(current, github.value, false);
  }

  // npm counts only when it freshly fetched a version; a stale cache is not
  // trusted as the source of truth for an explicit upgrade.
  const npmFresh =
    npm.status === "fulfilled" && npm.value && !npm.value.fromCache
      ? stableVersion(npm.value.latest)
      : null;
  if (npmFresh) {
    return toResult(current, npmFresh, false);
  }

  // Both sources failed: fall back to a cached value, if any.
  if (npm.status === "fulfilled" && npm.value?.fromCache) {
    return npm.value;
  }
  return null;
}

export async function refreshUpdateCheck(
  opts: RefreshUpdateCheckOptions = {},
): Promise<UpdateCheckResult | null> {
  const env = opts.env ?? process.env;
  const isTty = opts.isTty ?? true;
  const runMode = opts.runMode ?? false;
  if (!opts.ignoreSkip && shouldSkipUpdateCheck(env, { isTty, runMode })) {
    return null;
  }

  const current = opts.currentVersion ?? "0.0.0";
  const now = opts.now ?? Date.now();
  const cached = readUpdateCheckCache();
  if (!opts.forceRefresh && cached && now - cached.checkedAt <= UPDATE_CHECK_TTL_MS) {
    return toResult(current, cached.latestVersion, true);
  }

  const latest = await fetchNpmLatest(
    opts.fetchImpl ?? fetch,
    `praana/${current}`,
    opts.timeoutMs,
  );
  if (!latest) return cached ? toResult(current, cached.latestVersion, true) : null;

  writeUpdateCheckCache({
    version: CACHE_VERSION,
    checkedAt: now,
    latestVersion: latest,
    source: "npm",
  });
  return toResult(current, latest, false);
}
