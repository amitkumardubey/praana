import { describe, expect, it } from "bun:test";
import { displayFetchUrl, redactSensitiveFragment, redactSensitiveQuery, redactUrlsInText } from "../src/redact/url-query.js";

/**
 * Regressions for the OCR review findings on URL credential redaction:
 * common key spellings that were missed, control characters the URL parser
 * strips but the redactor did not, and the trailing-punctuation restore that
 * could put part of a credential back into the log.
 */
describe("redactSensitiveQuery key coverage", () => {
  const cases = [
    "?apiKey=abc123",
    "?apikey=abc123",
    "?client_secret=abc123",
    "?clientSecret=abc123",
    "?X-Amz-Signature=deadbeef",
    "?X-Amz-Credential=abc",
    "?X-Amz-Security-Token=abc",
    "?session_token=abc",
    "?refresh_token=abc",
    "?id_token=abc",
    "?private_key=abc",
    "?db_password=abc",
    "?my_app_secret=abc",
    "?auth_token=abc",
  ];

  for (const search of cases) {
    it(`redacts ${search}`, () => {
      const out = redactSensitiveQuery(search);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("abc123");
      expect(out).not.toContain("deadbeef");
    });
  }

  it("keeps non-sensitive parameters intact", () => {
    expect(redactSensitiveQuery("?page=2&sort=name&q=hello")).toBe("?page=2&sort=name&q=hello");
    expect(redactSensitiveQuery("?keyboard=mechanical")).toBe("?keyboard=mechanical");
    expect(redactSensitiveQuery("?monkey=see")).toBe("?monkey=see");
  });

  it("redacts only the sensitive parameter in a mixed query", () => {
    expect(redactSensitiveQuery("?page=2&access_token=abc&q=hi")).toBe("?page=2&access_token=[REDACTED]&q=hi");
  });
});

describe("redactSensitiveQuery control characters", () => {
  it("redacts a key split by a tab, which the URL parser strips", () => {
    expect(redactSensitiveQuery("?to\tken=abc123")).toBe("?to\tken=[REDACTED]");
  });

  it("redacts a key split by CR or LF", () => {
    expect(redactSensitiveQuery("?to\rken=abc123")).toContain("[REDACTED]");
    expect(redactSensitiveQuery("?to\nken=abc123")).toContain("[REDACTED]");
  });

  it("displayFetchUrl redacts a tab-split key after the URL parser normalises it", () => {
    const out = displayFetchUrl("https://example.test/?to\tken=abc123");
    expect(out).not.toBeNull();
    expect(out).not.toContain("abc123");
    expect(out).toContain("[REDACTED]");
  });
});

describe("redactUrlsInText trailing punctuation", () => {
  it("does not restore punctuation that belongs to a credential value", () => {
    const out = redactUrlsInText("see https://example.com/?password=abc);");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("[REDACTED]);");
  });

  it("does not leak a credential made entirely of punctuation", () => {
    const out = redactUrlsInText("x https://example.com/?password=);");
    expect(out).not.toContain(");");
    expect(out).toContain("[REDACTED]");
  });

  it("still strips sentence punctuation from a URL with no credential", () => {
    const out = redactUrlsInText("read https://example.com/page.");
    expect(out).toBe("read https://example.com/page.");
  });

  it("redacts a credential inside running text", () => {
    const out = redactUrlsInText("fetch https://example.com/a?token=secret123&x=1 now");
    expect(out).not.toContain("secret123");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("&x=1");
  });

  it("redacts a credential split by a tab inside running text", () => {
    const out = redactUrlsInText("fetch https://example.com/a?to\tken=secret123 now");
    expect(out).not.toContain("secret123");
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary URLs untouched", () => {
    const text = "see https://example.com/a?page=2 and http://other.test/b";
    expect(redactUrlsInText(text)).toBe(text);
  });
});

describe("redactSensitiveFragment", () => {
  it("redacts sensitive fragment pairs while keeping the fragment prefix", () => {
    expect(redactSensitiveFragment("#access_token=SECRET123456&state=abc")).toBe(
      "#access_token=[REDACTED]&state=abc",
    );
  });

  it("redacts a short fragment credential", () => {
    expect(redactSensitiveFragment("#token=abc123")).toBe("#token=[REDACTED]");
  });

  it("redacts a bare fragment value that is credential-bearing", () => {
    expect(redactSensitiveFragment("apiKey=SECRET123456")).toBe("apiKey=[REDACTED]");
  });

  it("leaves an ordinary fragment untouched", () => {
    expect(redactSensitiveFragment("#section-1")).toBe("#section-1");
    expect(redactSensitiveFragment("#state=abc")).toBe("#state=abc");
    expect(redactSensitiveFragment("")).toBe("");
  });
});

describe("redactUrlsInText fragments", () => {
  it("redacts a fragment credential in running text", () => {
    const out = redactUrlsInText("see https://example.com/cb#access_token=SECRET123456 please");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("SECRET123456");
  });

  it("redacts a credential-bearing oauth-style fragment", () => {
    const out = redactUrlsInText("fetch https://accounts.example/oauth#access_token=SECRET123456&token_type=Bearer now");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("SECRET123456");
  });

  it("leaves a fragment without credentials untouched", () => {
    expect(redactUrlsInText("see https://example.com/page#section")).toBe("see https://example.com/page#section");
  });
});

describe("displayFetchUrl fragments", () => {
  it("redacts a fragment credential in the displayed URL", () => {
    const out = displayFetchUrl("https://example.com/cb#access_token=SECRET123456");
    expect(out).not.toBeNull();
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("SECRET123456");
  });
});
