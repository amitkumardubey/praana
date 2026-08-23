/**
 * Per-session content-hash cache for post-edit verification (#299).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function hashFileBytes(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export class VerifyHashCache {
  private readonly hashes = new Map<string, string>();

  isFresh(absPath: string): boolean {
    const hash = hashFileBytes(absPath);
    if (!hash) return false;
    return this.hashes.get(absPath) === hash;
  }

  remember(absPath: string): void {
    const hash = hashFileBytes(absPath);
    if (hash) this.hashes.set(absPath, hash);
  }

  forget(absPath: string): void {
    this.hashes.delete(absPath);
  }
}
