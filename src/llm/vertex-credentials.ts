import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { resolveAgainstCwd } from "../app-identity.js";

export interface GoogleCredentialOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathImpl?: typeof path.win32;
}

/** Expand only the current user's leading ~, using the home at call time. */
export function resolveGoogleCredentialPath(value: string, opts: GoogleCredentialOptions = {}): string {
  const env = opts.env ?? process.env;
  const paths = opts.pathImpl ?? path;
  const home = (opts.platform ?? process.platform) === "win32"
    ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  let expanded = value;
  if (value === "~" || /^~[/\\]/.test(value)) {
    if (!home) throw new Error("Google ADC credential path requires HOME or USERPROFILE");
    expanded = paths.join(home, value.slice(2));
  }
  return paths.normalize(resolveAgainstCwd(expanded, paths.resolve(opts.cwd ?? process.cwd()), paths));
}

export function wellKnownGoogleAdcPath(opts: GoogleCredentialOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const paths = opts.pathImpl ?? path;
  if (env.CLOUDSDK_CONFIG?.trim()) {
    return paths.join(resolveGoogleCredentialPath(env.CLOUDSDK_CONFIG, opts), "application_default_credentials.json");
  }
  const windows = (opts.platform ?? process.platform) === "win32";
  const home = windows ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  if (windows && env.APPDATA) {
    return paths.join(resolveGoogleCredentialPath(env.APPDATA, opts), "gcloud", "application_default_credentials.json");
  }
  if (!home) return undefined;
  return paths.join(resolveGoogleCredentialPath(home, opts), ...(windows ? ["AppData", "Roaming"] : [".config"]), "gcloud", "application_default_credentials.json");
}

export function looksLikeGoogleCredentialPath(value: string): boolean {
  return value.endsWith(".json") || value.includes("/") || value.includes("\\") || value.startsWith("~");
}

/** Explicit files are selected even when missing so the caller gets a clear error. */
export function vertexCredentialFile(opts: { apiKey?: string; bearerToken?: string } = {}): string | undefined {
  const configured = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const stored = [opts.apiKey, opts.bearerToken].find((v) => v && looksLikeGoogleCredentialPath(v));
  if (configured || stored) return resolveGoogleCredentialPath(configured || stored!);
  const ambient = wellKnownGoogleAdcPath();
  return ambient && existsSync(ambient) ? ambient : undefined;
}

export interface GoogleCredentialFile {
  data: Record<string, unknown>;
  /** Identity of the descriptor actually read, never the later path target. */
  cacheKey: string;
}

export function readGoogleCredentialFile(file: string): GoogleCredentialFile {
  const absolute = resolveGoogleCredentialPath(file);
  let fd: number;
  try {
    fd = openSync(absolute, "r");
  } catch {
    throw new Error("Google ADC credential file not found or unreadable");
  }
  try {
    const stat = fstatSync(fd);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      // SyntaxError can quote credential bytes. Never retain it, even as cause.
      throw new Error("Invalid Google ADC credential JSON file");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid Google ADC credential JSON object");
    }
    return {
      data: parsed as Record<string, unknown>,
      cacheKey: JSON.stringify([absolute, stat.size, stat.mtimeMs, stat.ino]),
    };
  } finally {
    closeSync(fd);
  }
}

export function vertexProjectFromCredentials(opts: { apiKey?: string; bearerToken?: string }): string | undefined {
  const file = vertexCredentialFile(opts);
  if (!file) return undefined;
  const { data } = readGoogleCredentialFile(file);
  const project = data.type === "service_account" ? data.project_id
    : data.type === "authorized_user" ? data.quota_project_id : undefined;
  return typeof project === "string" && project ? project : undefined;
}
