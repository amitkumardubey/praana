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
import { OAuthUserCancelledError } from "../src/ui/tui/oauth-login-ui.js";
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

  /** Drive the wizard to the anthropic OAuth screen with a stub login. */
  async function renderAnthropicOAuth(
    login: (
      interaction: { prompt(p: { type: string; message: string }): Promise<string> },
    ) => Promise<unknown>,
  ) {
    const home = mkdtempSync(join(tmpdir(), "praana-wizard-oauth-"));
    const previousHome = process.env.PRAANA_HOME;
    const previousBrowser = process.env.PRAANA_OPEN_BROWSER;
    process.env.PRAANA_HOME = home;
    process.env.PRAANA_OPEN_BROWSER = "0";
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests({}, {
      anthropic: {
        name: "Anthropic",
        async login(interaction) {
          await login(interaction);
          return { type: "oauth", access: "acc", refresh: "ref", expires: Date.now() + 3600 * 1000 };
        },
        async refresh(credential) { return credential; },
        async toAuth() { return {}; },
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let done: SetupResult | undefined;
    const setup = await createTestRenderer({ width: 100, height: 40 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    const teardown = async () => {
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
    };
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
      await setup.mockInput.typeText("anthropic", 0);
      await settle(setup, (frame) => frame.includes("anthropic") && frame.includes("1 shown"));
      setup.mockInput.pressEnter();
      await settle(setup, (frame) => frame.includes("How do you want to authenticate?"));
      setup.mockInput.pressEnter();
      return { setup, done, unhandled, teardown };
    } catch (error) {
      await teardown();
      throw error;
    }
  }

  it("steps back when the login resolves after Esc cancelled the paste prompt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { setup, done, unhandled, teardown } = await renderAnthropicOAuth(async (interaction) => {
      // The prompt is dismissed by Esc (OAuthUserCancelledError); the login
      // swallows that cancellation and still succeeds afterwards.
      await interaction.prompt({ type: "secret", message: "Paste your Anthropic API key or Claude Pro OAuth token:" })
        .catch(() => {});
      await gate;
    });
    try {
      await settle(setup, (frame) => frame.includes("Paste your Anthropic"));
      setup.mockInput.pressEscape();
      // Esc dismisses the prompt and lands on the status screen; the login is
      // still pending. Release it so it RESOLVES after the abort was seen.
      let status = "";
      for (let i = 0; i < 40 && !status.includes("Starting OAuth for anthropic…"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await setup.renderOnce();
        status = setup.captureCharFrame();
      }
      expect(status).toContain("Starting OAuth for anthropic…");
      release();
      // The status screen is transient; Esc/back lands on the auth-method
      // step the user came from.
      const back = await settle(setup, (frame) => frame.includes("Selected: anthropic"));
      expect(back).not.toContain("OAuth failed");
      expect(back).not.toContain("Paste your Anthropic");
      expect(back).not.toContain("Starting OAuth for anthropic…");
      expect(done).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it("steps back immediately on Esc from the status screen and does not pop again on a later rejection", async () => {
    let fail!: (reason: unknown) => void;
    const gate = new Promise<never>((_, reject) => { fail = reject; });
    const { setup, done, unhandled, teardown } = await renderAnthropicOAuth(async () => {
      await gate;
    });
    try {
      await settle(setup, (frame) => frame.includes("OAuth: anthropic") && frame.includes("Starting OAuth for anthropic…"));
      // The login promise never settles on its own; Esc must still step back.
      // The status screen has no focusable part to pump the key parser, so
      // give the dispatch real wall-clock ticks.
      setup.mockInput.pressEscape();
      let back = "";
      for (let i = 0; i < 40 && !back.includes("Selected: anthropic"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await setup.renderOnce();
        back = setup.captureCharFrame();
      }
      expect(back).toContain("Selected: anthropic");
      expect(back).not.toContain("OAuth failed");
      expect(back).not.toContain("Starting OAuth for anthropic…");
      // A later rejection with the user-cancel reason must not pop again.
      fail(new OAuthUserCancelledError());
      await new Promise((resolve) => setTimeout(resolve, 60));
      const after = await settle(setup, (frame) => frame.includes("Selected: anthropic"));
      expect(after).not.toContain("OAuth failed");
      expect(after).not.toContain("Starting OAuth for anthropic…");
      expect(done).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      await teardown();
    }
  });
});
