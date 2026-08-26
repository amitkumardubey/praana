/**
 * Tests for Solid login routing helpers.
 */
import { describe, expect, test } from "bun:test";
import {
  routeAfterLoginProviderChoice,
  routeLoginHint,
} from "../src/ui/tui/overlays/login.js";

describe("login overlay routing", () => {
  test("routes an unknown /login hint into custom-provider URL entry", () => {
    expect(
      routeLoginHint("local-llm", {
        isKnownProvider: false,
        isUserDeclaredProvider: false,
        hasApiKey: false,
        hasCredentials: false,
        hasOAuthToken: false,
        providerRequiresApiKey: false,
        providerSupportsOAuth: false,
        isOAuthOnlyProvider: false,
        bedrockNeedsApiKeyPrompt: false,
      }),
    ).toEqual({ step: "custom-url", customId: "local-llm" });
  });

  test("routes an OAuth provider without credentials to auth-method selection", () => {
    expect(
      routeAfterLoginProviderChoice("anthropic", {
        hasApiKey: false,
        hasCredentials: false,
        hasOAuthToken: false,
        providerRequiresApiKey: true,
        providerSupportsOAuth: true,
        isOAuthOnlyProvider: false,
        bedrockNeedsApiKeyPrompt: false,
      }),
    ).toBe("auth-method");
  });

  test("treats a user-declared provider as custom even when its id is catalogued", () => {
    expect(
      routeLoginHint("openai", {
        isKnownProvider: true,
        isUserDeclaredProvider: true,
        hasApiKey: true,
        hasCredentials: false,
        hasOAuthToken: false,
        providerRequiresApiKey: false,
        providerSupportsOAuth: false,
        isOAuthOnlyProvider: false,
        bedrockNeedsApiKeyPrompt: false,
      }),
    ).toEqual({ step: "has-key", provider: "openai" });
  });

  test("routes Bedrock without ambient credentials to key entry", () => {
    expect(
      routeAfterLoginProviderChoice("amazon-bedrock", {
        hasApiKey: false,
        hasCredentials: false,
        hasOAuthToken: false,
        providerRequiresApiKey: false,
        providerSupportsOAuth: false,
        isOAuthOnlyProvider: false,
        bedrockNeedsApiKeyPrompt: true,
      }),
    ).toBe("key");
  });
});
