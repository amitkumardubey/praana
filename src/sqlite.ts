/**
 * Bun SQLite bootstrap. Call `initBunSqlite()` once at process startup before
 * opening any database (required on macOS for sqlite-vec extension loading).
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { platform } from "node:os";

/** Homebrew libsqlite3 paths (Apple's system SQLite disables extensions). */
const MACOS_SQLITE_DYLIB_CANDIDATES = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
] as const;

let initialized = false;

export type PraanaDatabase = Database;

export function initBunSqlite(): void {
  if (initialized) return;
  initialized = true;

  if (platform() !== "darwin") return;

  for (const dylib of MACOS_SQLITE_DYLIB_CANDIDATES) {
    if (existsSync(dylib)) {
      Database.setCustomSQLite(dylib);
      return;
    }
  }

  throw new Error(
    [
      "sqlite-vec requires a SQLite build with extension loading.",
      "macOS system SQLite does not support extensions.",
      "Install Homebrew SQLite: brew install sqlite",
      `Then ensure one of these exists: ${MACOS_SQLITE_DYLIB_CANDIDATES.join(", ")}`,
    ].join(" "),
  );
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
