/**
 * Platform helpers shared by tests.
 *
 * The suite is developed on POSIX and run on Linux CI; a few tests also run
 * on Windows. `isWindows` lets a test restrict an assertion or skip a case
 * that needs a POSIX-only feature.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";

/** True when the test process is running on Windows. */
export const isWindows = process.platform === "win32";

/**
 * Remove a temp file/dir, retrying briefly on Windows.
 *
 * Windows cannot delete a file/dir while a handle is still open (EBUSY).
 * Tests close what they can before cleanup; for handles that have no close
 * API from tests (e.g. the pino-roll session log stream), retry a few times
 * so the removal still succeeds once the OS releases them. No-op behaviour on
 * POSIX (maxRetries 0, same as plain rmSync).
 */
export function rmForce(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: isWindows ? 5 : 0,
    retryDelay: 100,
  });
}

/**
 * Normalise CRLF → LF line endings in text read from a git checkout.
 *
 * On Windows, git may check text files out with CRLF endings even though the
 * committed blobs use LF. That changes the bytes and breaks pinned hashes and
 * exact-string comparisons. This is a no-op on POSIX, where checkout bytes are
 * exactly the committed bytes (and some fixtures intentionally contain CRLF).
 */
export function normalizeText(text: string): string {
  return isWindows ? text.replace(/\r\n/g, "\n") : text;
}

function looksBinary(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
  }
  return false;
}

/**
 * Line-ending-normalised form of raw file bytes. Returns the original bytes
 * on POSIX or for binary content.
 */
export function normalizeBytes(bytes: Uint8Array): Uint8Array {
  if (!isWindows || looksBinary(bytes)) return bytes;
  const text = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
  return Buffer.from(text, "utf8");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Digest of bytes as they exist in the repo.
 *
 * A Windows checkout may carry CRLF line endings; when the raw bytes do not
 * match the pinned digest (and the content is text), the LF-normalised bytes
 * are hashed instead. On POSIX the raw bytes are always used, so results are
 * unchanged there.
 */
export function checkoutDigest(bytes: Uint8Array, pinned: string): string {
  const raw = sha256Hex(bytes);
  if (!isWindows || raw === pinned) return raw;
  return sha256Hex(normalizeBytes(bytes));
}
