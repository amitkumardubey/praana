/**
 * Esc on the Codex manual-paste prompt must quiet-cancel the setup wizard
 * back to the previous step. A bare signal abort is covered in
 * tests/oauth-login-ui.test.ts and must stay an AbortError.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { resetCredentialStoreForTests } from "../src/credentials.js";
import { resetOAuthProvidersForTests } from "../src/oauth.js";
import { SetupWizard } from "../src/ui/tui/setup-wizard.js";
import type { SetupResult } from "../src/setup/types.js";

async function settle(setup: TestRendererSetup, predicate: (frame: string) => boolean): Promise<string> {
  let frame = "";
  for (let i = 0; i < 40; i++) {
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    await setup.flush();
  }
  throw new Error(`frame never matched:\n${frame}`);
}

describe("setup wizard OAuth cancel", () => {
  it("Esc on the Codex manual-paste prompt returns to the previous step", async () => {
    const home = mkdtempSync(join(tmpdir(), "praana-wizard-esc-"));
    const previousHome = process.env.PRAANA_HOME;
    const previousBrowser = process.env.PRAANA_OPEN_BROWSER;
    process.env.PRAANA_HOME = home;
    process.env.PRAANA_OPEN_BROWSER = "0";
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests({
      fetch: (async () => {
        throw new Error("token endpoint should not be called");
      }) as typeof fetch,
      callbackServer: async () => ({
        wait: () => new Promise<string>(() => {}),
        close() {},
      }),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let done: SetupResult | undefined;
    const setup = await createTestRenderer({ width: 100, height: 40 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    try {
      await render(
        () =>
          createComponent(KeymapProvider, {
            keymap,
            children: () =>
              createComponent(SetupWizard, {
                onDone: (result: SetupResult) => {
                  done = result;
                },
              }),
          }),
        setup.renderer,
      );
      await settle(setup, (frame) => frame.includes("Choose a provider:"));
      // Filter the provider picker down to the Codex entry.
      await setup.mockInput.typeText("codex", 0);
      const filtered = await settle(setup, (frame) => frame.includes("openai-codex") && frame.includes("1 shown"));
      expect(filtered).toContain("openai-codex");
      setup.mockInput.pressEnter();
      await settle(setup, (frame) => frame.includes("Browser login"));
      setup.mockInput.pressEnter();
      await settle(setup, (frame) => frame.includes("Paste the redirect"));
      setup.mockInput.pressEscape();
      // The cancellation unwinds the OAuth promise chain before the wizard
      // steps back; give it a tick so the quiet step-back is visible.
      await new Promise((resolve) => setTimeout(resolve, 80));
      const back = await settle(setup, (frame) => frame.includes("Choose a provider:"));
      expect(back).not.toContain("OAuth failed");
      expect(back).not.toContain("Paste the redirect");
      expect(done).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      setup.mockInput.pressCtrlC();
      await setup.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      setup.renderer.destroy();
      process.off("unhandledRejection", onUnhandled);
      resetOAuthProvidersForTests();
      resetCredentialStoreForTests();
      if (previousHome === undefined) delete process.env.PRAANA_HOME;
      else process.env.PRAANA_HOME = previousHome;
      if (previousBrowser === undefined) delete process.env.PRAANA_OPEN_BROWSER;
      else process.env.PRAANA_OPEN_BROWSER = previousBrowser;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
