#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = join(root, "dist/main.js");

if (!existsSync(main)) {
  console.error("[aria] Not built yet. From the repo root, run: npm run build");
  process.exit(1);
}

await import(main);
