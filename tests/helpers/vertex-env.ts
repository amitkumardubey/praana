import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolate every ambient Vertex source, including a developer's gcloud config. */
export function useCleanVertexEnv(): void {
  let saved: Record<string, string | undefined>;
  let configDir: string;
  beforeEach(() => {
    const keys = Object.keys(process.env).filter((key) => /^(GCP_|GOOGLE_|VERTEX_)/.test(key));
    saved = Object.fromEntries([...keys, "CLOUDSDK_CONFIG"].map((key) => [key, process.env[key]]));
    for (const key of Object.keys(saved)) delete process.env[key];
    configDir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
    process.env.CLOUDSDK_CONFIG = configDir;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (/^(GCP_|GOOGLE_|VERTEX_)/.test(key) || key === "CLOUDSDK_CONFIG") delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
    rmSync(configDir, { recursive: true, force: true });
  });
}
