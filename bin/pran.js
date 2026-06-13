#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = join(root, "dist/main.js");

if (!existsSync(mainPath)) {
  process.stderr.write(
    "[pran] Not built yet. From the repo root, run: npm run build\n"
  );
  process.exit(1);
}

const mod = await import(mainPath);
await mod.main();
