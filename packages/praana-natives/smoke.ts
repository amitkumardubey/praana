/**
 * Bun smoke test for the native addon.
 * Run after `bun run build` in this package.
 */

import { nativeVersion, ping } from "./index.js";

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

console.log(`@praana/natives smoke ok version=${version} ping=${pong}`);
