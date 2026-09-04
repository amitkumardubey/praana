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
import { isNewer, normalizeVersionLabel } from "./semver.js";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 1500;
export const NPM_LATEST_URL = "https://registry.npmjs.org/praana/latest";

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
  now?: number;
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
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
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
  if (cached && now - cached.checkedAt <= UPDATE_CHECK_TTL_MS) {
    return toResult(current, cached.latestVersion, true);
  }

  const latest = await fetchNpmLatest(
    opts.fetchImpl ?? fetch,
    `praana/${current}`,
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
