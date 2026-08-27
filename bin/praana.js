#!/usr/bin/env bun
/**
 * Global CLI entry. Registers a package-scoped OpenTUI Solid JSX transform
 * before importing any .tsx — required because stock @opentui/solid/preload
 * skips paths under node_modules (where `bun add -g` installs this package).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerPraanaSolidTransform } from "./opentui-solid-runtime.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await registerPraanaSolidTransform(root);

const mod = await import(join(root, "src/main.ts"));
await mod.main();
