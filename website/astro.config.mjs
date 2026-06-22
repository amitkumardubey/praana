import { defineConfig } from "astro/config";

// https://amitkumardubey.github.io/praana/
export default defineConfig({
  site: "https://amitkumardubey.github.io",
  base: "/praana",
  trailingSlash: "always",
  outDir: "dist",
});
