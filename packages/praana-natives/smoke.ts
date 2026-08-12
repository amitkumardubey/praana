/**
 * Bun smoke test for the native addon.
 * Run after `bun run build` in this package.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  nativeVersion,
  ping,
  listSymbols,
  parseFile,
} from "./index.js";

const version = nativeVersion();
const pong = ping();

if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`smoke fail: nativeVersion() => ${JSON.stringify(version)}`);
  process.exit(1);
}
if (pong !== "pong") {
  console.error(`smoke fail: ping() => ${JSON.stringify(pong)}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "praana-natives-smoke-"));
const fixture = join(dir, "smoke.ts");
try {
  writeFileSync(
    fixture,
    "export function smokeTarget() { return 1; }\n",
    "utf8",
  );
  const parsed = parseFile(fixture);
  if (!parsed.ok) {
    console.error(`smoke fail: parseFile => ${JSON.stringify(parsed)}`);
    process.exit(1);
  }
  const symbols = listSymbols(fixture);
  if (!symbols.ok || !symbols.symbols.some((s) => s.name === "smokeTarget")) {
    console.error(`smoke fail: listSymbols => ${JSON.stringify(symbols)}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `@praana/natives smoke ok version=${version} ping=${pong} listSymbols=ok`,
);
