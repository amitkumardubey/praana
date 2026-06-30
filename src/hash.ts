import { createHash } from "node:crypto";

/** Stable 12-char SHA-256 prefix for a string. Used for scope keys and IDs. */
export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
