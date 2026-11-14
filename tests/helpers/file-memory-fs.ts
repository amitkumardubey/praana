import * as nodeFs from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface MemoryPathRecord { operation: string; path: string }

/** Fail closed on unrecorded operations so new filesystem calls cannot evade isolation checks. */
export function recordMemoryPaths(home: string, onPath?: (record: MemoryPathRecord) => void) {
  const root = resolve(home);
  const paths: MemoryPathRecord[] = [];
  const singlePath = new Set(["lstat", "stat", "mkdir", "realpath", "readdir", "open", "unlink"]);
  const fs = new Proxy(nodeFs, { get(target, key) {
    const original = Reflect.get(target, key);
    if (typeof original !== "function") return original;
    return (...args: unknown[]) => {
      const operation = String(key);
      const count = operation === "rename" ? 2 : singlePath.has(operation) ? 1 : 0;
      if (!count) throw new Error(`Unrecorded filesystem operation: ${operation}`);
      for (const arg of args.slice(0, count)) {
        if (typeof arg !== "string" || !isAbsolute(arg)) throw new Error(`Non-absolute filesystem path: ${String(arg)}`);
        const rel = relative(root, arg);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Filesystem path escaped injected home: ${arg}`);
        const record = { operation, path: arg };
        paths.push(record);
        onPath?.(record);
      }
      return original(...args);
    };
  } });
  return { fs, paths };
}
