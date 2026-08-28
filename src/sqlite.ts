/**
 * Bun SQLite bootstrap. Call `initBunSqlite()` once at process startup before
 * opening any database.
 *
 * Vector recall uses BLOB + cosine in TypeScript — no SQLite extension load,
 * so Homebrew SQLite is not required on macOS.
 */
import { Database } from "bun:sqlite";

let initialized = false;

export type PraanaDatabase = Database;

/** Default milliseconds to wait when a SQLite connection hits a BUSY writer. */
export const BUSY_TIMEOUT_MS = 5000;

export function initBunSqlite(): void {
  initialized = true;
}

/**
 * Apply the concurrency pragma set we rely on for multi-session safety:
 * WAL mode (readers/writers don't block each other) and a non-zero busy
 * timeout so concurrent writers retry instead of immediately returning
 * SQLITE_BUSY.
 */
export function applyConcurrencyPragmas(db: PraanaDatabase): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.run("PRAGMA foreign_keys = ON");
}

export function openDatabase(
  path: string,
  options?: { readonly?: boolean; create?: boolean },
): PraanaDatabase {
  initBunSqlite();
  // bun:sqlite creates a stray on-disk file when ":memory:" is passed literally.
  // Also catch join(cwd, ":memory:") forms — ":memory:" is a reserved SQLite
  // token, no real file should ever have that basename.
  const base = path.split("/").pop() ?? path;
  if (base === ":memory:") return new Database();
  return new Database(path, options);
}
