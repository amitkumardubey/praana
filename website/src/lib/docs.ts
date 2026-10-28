import { readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

// The markdown sources live in ../docs relative to the website directory. Resolve from
// the working directory (astro dev/build always run inside website/) instead of this
// file's location: Astro bundles prerendered pages into dist/.prerender/chunks, so a
// path relative to import.meta.url points somewhere else after the build.
const docsDir = join(process.cwd(), "..", "docs");

export function loadDoc(filename: string): string {
  return readFileSync(join(docsDir, filename), "utf-8");
}

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { gfm: true, async: false }) as string;
}
