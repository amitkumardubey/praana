/**
 * LSP Auto-installer and binary resolver.
 *
 * Checks system PATH first, then ~/.praana/lsp cache, and auto-installs
 * default language servers on demand into ~/.praana/lsp/.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { appHomePath } from "../app-identity.js";
import { commandOnPath } from "../verify/spawn.js";
import type { LspConfig } from "../types.js";
import {
  DEFAULT_LSP_SERVERS,
  resolveServerArgv,
  resolveServerKey,
  type DefaultLspServerSpec,
} from "./language.js";

const installLocks = new Map<string, Promise<string[] | null>>();

export interface ResolveLspOptions {
  config: LspConfig;
  lspCacheDir?: string;
  installFn?: (
    spec: DefaultLspServerSpec,
    cacheDir: string,
  ) => Promise<string | null>;
}

export function getLspCacheDir(): string {
  return appHomePath("lsp");
}

function findLocalNodeBin(cacheDir: string, binary: string): string | null {
  const binPath = join(cacheDir, "node_modules", ".bin", binary);
  if (existsSync(binPath)) return binPath;

  if (process.platform === "win32") {
    const cmdPath = join(cacheDir, "node_modules", ".bin", `${binary}.cmd`);
    if (existsSync(cmdPath)) return cmdPath;
  }

  return null;
}

export async function runSpawnInstall(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        cwd,
        stdio: "ignore",
      });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function defaultInstallNpmPackages(
  spec: DefaultLspServerSpec,
  cacheDir: string,
): Promise<string | null> {
  if (!spec.npmPackages?.length) return null;

  try {
    mkdirSync(cacheDir, { recursive: true });
    const pkgJsonPath = join(cacheDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(
        pkgJsonPath,
        JSON.stringify({ name: "praana-lsp-cache", private: true }, null, 2),
        "utf-8",
      );
    }

    const hasBun = commandOnPath("bun");
    const hasNpm = commandOnPath("npm");

    let success = false;
    if (hasBun) {
      success = await runSpawnInstall("bun", ["add", "-d", ...spec.npmPackages], cacheDir);
    } else if (hasNpm) {
      success = await runSpawnInstall("npm", ["install", "--save-dev", ...spec.npmPackages], cacheDir);
    }

    if (success) {
      return findLocalNodeBin(cacheDir, spec.binary);
    }
  } catch {
    return null;
  }
  return null;
}

async function defaultInstallToolchain(
  spec: DefaultLspServerSpec,
): Promise<string | null> {
  if (!spec.toolchainInstall) return null;
  const { command, args } = spec.toolchainInstall;
  if (!commandOnPath(command)) return null;

  try {
    const ok = await runSpawnInstall(command, args, process.cwd());
    if (ok && commandOnPath(spec.binary)) {
      return spec.binary;
    }
  } catch {
    return null;
  }
  return null;
}

export async function defaultInstallServer(
  spec: DefaultLspServerSpec,
  cacheDir: string,
): Promise<string | null> {
  if (spec.npmPackages?.length) {
    return defaultInstallNpmPackages(spec, cacheDir);
  }
  if (spec.toolchainInstall) {
    return defaultInstallToolchain(spec);
  }
  return null;
}

/**
 * Resolves the server command to execute for a language.
 *
 * Resolution order:
 * 1. Explicit user config override in `config.servers`.
 * 2. On-PATH binary for the default server spec.
 * 3. Cached binary in `~/.praana/lsp/node_modules/.bin/`.
 * 4. Auto-installation into `~/.praana/lsp/` when auto_install !== false.
 */
export async function resolveOrInstallServer(
  language: string,
  opts: ResolveLspOptions,
): Promise<string[] | null> {
  const key = resolveServerKey(language, opts.config.servers);
  if (!key) return null;

  // 1. Explicit config override always wins
  const configured = opts.config.servers[key];
  if (configured && configured.length > 0) {
    return configured;
  }

  const defaultSpec = DEFAULT_LSP_SERVERS[key];
  if (!defaultSpec) return null;

  // 2. On-PATH binary check
  if (commandOnPath(defaultSpec.binary)) {
    return [defaultSpec.binary, ...defaultSpec.args];
  }

  const cacheDir = opts.lspCacheDir ?? getLspCacheDir();

  // 3. Cached local installation check
  const cachedBin = findLocalNodeBin(cacheDir, defaultSpec.binary);
  if (cachedBin) {
    return [cachedBin, ...defaultSpec.args];
  }

  // 4. If auto-install is disabled, do not attempt download
  if (opts.config.auto_install === false) {
    return null;
  }

  // 5. Auto-install with concurrency lock per language key
  const existingLock = installLocks.get(key);
  if (existingLock) {
    return existingLock;
  }

  const installPromise = (async () => {
    try {
      const installFn = opts.installFn ?? defaultInstallServer;
      const installedBin = await installFn(defaultSpec, cacheDir);
      if (installedBin) {
        return [installedBin, ...defaultSpec.args];
      }
      return null;
    } finally {
      installLocks.delete(key);
    }
  })();

  installLocks.set(key, installPromise);
  return installPromise;
}
