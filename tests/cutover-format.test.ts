import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("file-memory cutover keeps the surrounding formatting", () => {
  const compact = source("../src/auto-compact.ts");
  expect(compact).toContain('out.push({\n          type: "user_message",');
  expect(compact).toContain("      default:\n        break;");

  const banner = source("../src/app-banner.ts");
  expect(banner).toContain("export function printSessionBanner(session: Session, cwd: string, model: string): void {");

  const compiler = source("../src/compiler.ts");
  const classic = source("../src/compile-classic.ts");
  expect(compiler).not.toContain("_toolSchemas");
  expect(classic).not.toContain("_toolSchemas");
  expect(classic).toContain("   nativeStatus?: NativeAddonStatus | null,\n  memoryEnabled");
});
