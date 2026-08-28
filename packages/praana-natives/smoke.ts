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
  grep,
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
const fixtureTs = join(dir, "smoke.ts");
const fixtureRs = join(dir, "smoke.rs");
try {
  writeFileSync(
    fixtureTs,
    "export function smokeTarget() { return 1; }\n",
    "utf8",
  );
  writeFileSync(fixtureRs, "pub fn smoke_rs() {}\n", "utf8");

  const parsed = parseFile(fixtureTs);
  if (!parsed.ok) {
    console.error(`smoke fail: parseFile => ${JSON.stringify(parsed)}`);
    process.exit(1);
  }
  const symbols = listSymbols(fixtureTs);
  if (!symbols.ok || !symbols.symbols.some((s) => s.name === "smokeTarget")) {
    console.error(`smoke fail: listSymbols => ${JSON.stringify(symbols)}`);
    process.exit(1);
  }

  const parsedRs = parseFile(fixtureRs);
  if (!parsedRs.ok || parsedRs.language !== "rust") {
    console.error(`smoke fail: parseFile(.rs) => ${JSON.stringify(parsedRs)}`);
    process.exit(1);
  }
  const symbolsRs = listSymbols(fixtureRs);
  if (!symbolsRs.ok || !symbolsRs.symbols.some((s) => s.name === "smoke_rs")) {
    console.error(`smoke fail: listSymbols(.rs) => ${JSON.stringify(symbolsRs)}`);
    process.exit(1);
  }

  writeFileSync(join(dir, "probe.txt"), "praana-native-grep-probe\n", "utf8");
  const grepResult = grep({ pattern: "praana-native-grep-probe", path: dir, maxResults: 1 });
  if (!grepResult.ok || grepResult.matches.length < 1) {
    console.error(`smoke fail: grep => ${JSON.stringify(grepResult)}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `@praana/natives smoke ok version=${version} ping=${pong} listSymbols=ok rust=ok grep=ok`,
);
