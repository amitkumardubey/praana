import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getEmbedderConsent,
  setEmbedderConsent,
  needsInteractiveEmbedderConsent,
} from "../src/memory/embedder-consent.js";
import { confirmModelDownload } from "../src/ui/tui/download-consent.js";

describe("embedder consent", () => {
  let tmpHome: string;
  let originalTty: boolean | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "praana-consent-"));
    process.env.PRAANA_HOME = tmpHome;
    originalTty = process.stderr.isTTY;
  });

  afterEach(() => {
    delete process.env.PRAANA_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
    Object.defineProperty(process.stderr, "isTTY", {
      value: originalTty,
      configurable: true,
    });
  });

  it("records proceed and skip", () => {
    expect(getEmbedderConsent()).toBeNull();
    setEmbedderConsent("proceed");
    expect(getEmbedderConsent()).toBe("proceed");
    expect(existsSync(join(tmpHome, ".praana", ".embedder-consent"))).toBe(true);
    expect(readFileSync(join(tmpHome, ".praana", ".embedder-consent"), "utf-8")).toContain("proceed");
    setEmbedderConsent("skip");
    expect(getEmbedderConsent()).toBe("skip");
  });

  it("confirmModelDownload honors recorded consent without a nested TUI", async () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    setEmbedderConsent("skip");
    await expect(confirmModelDownload("Xenova/all-MiniLM-L6-v2")).resolves.toBe(false);
    setEmbedderConsent("proceed");
    await expect(confirmModelDownload("Xenova/all-MiniLM-L6-v2")).resolves.toBe(true);
  });

  it("does not require interactive consent when stderr is not a TTY", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    expect(needsInteractiveEmbedderConsent({ enabled: true, summarizer: "disabled", embedder: "auto" })).toBe(false);
  });
});
