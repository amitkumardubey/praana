import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../docs");

export function loadDoc(filename: string): string {
  return readFileSync(join(docsDir, filename), "utf-8");
}

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { gfm: true, async: false }) as string;
}
