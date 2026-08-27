#!/usr/bin/env bun
/**
 * Global CLI entry. Preload OpenTUI Solid before any .tsx import so Bun does not
 * fall back to react/jsx-dev-runtime when cwd has no package tsconfig/bunfig
 * (common for `bun add -g` / `bunx` launches).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

await import("@opentui/solid/preload");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(join(root, "src/main.ts"));
await mod.main();
