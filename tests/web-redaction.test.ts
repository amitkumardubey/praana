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

describe("redactSensitiveFragment encoded route separators", () => {
  it("redacts keys behind percent-encoded route separators", () => {
    expect(redactSensitiveFragment("#/cb%3Ftoken=SECRET")).toBe(
      "#/cb%3Ftoken=[REDACTED]",
    );
    expect(redactSensitiveFragment("#%2Fcb%3Ftoken=SECRET")).toBe(
      "#%2Fcb%3Ftoken=[REDACTED]",
    );
  });

  it("redacts a key starting with a bang", () => {
    expect(redactSensitiveFragment("#!token=abc")).toBe("#!token=[REDACTED]");
  });
});

describe("redactSensitiveFragment SPA-route and semicolon pairs", () => {
  it("redacts pairs split by semicolons", () => {
    expect(redactSensitiveFragment("#a=1;token=abc")).toBe("#a=1;token=[REDACTED]");
    expect(redactSensitiveFragment("#state=ok;access_token=XYZ")).toBe(
      "#state=ok;access_token=[REDACTED]",
    );
  });

  it("redacts sensitive keys behind an SPA route prefix", () => {
    expect(redactSensitiveFragment("#/cb?token=SECRET1")).toBe("#/cb?token=[REDACTED]");
    expect(redactSensitiveFragment("#/x;token=SECRET3")).toBe("#/x;token=[REDACTED]");
    expect(redactSensitiveFragment("#state=ok&/cb?token=XYZ")).toBe(
      "#state=ok&/cb?token=[REDACTED]",
    );
  });

  it("keeps non-sensitive route-prefixed fragments unchanged", () => {
    expect(redactSensitiveFragment("#/guide/install")).toBe("#/guide/install");
    expect(redactSensitiveFragment("#section")).toBe("#section");
  });
});

describe("redactSensitiveQuery semicolon pairs", () => {
  it("keeps existing behaviour for non-sensitive semicolon pairs", () => {
    expect(redactSensitiveQuery("?a=1;b=2")).toBe("?a=1;b=2");
  });

  it("redacts a sensitive pair split by a semicolon", () => {
    expect(redactSensitiveQuery("?a=1;token=abc")).toBe("?a=1;token=[REDACTED]");
  });

  it("swallows the tail of a semicolon-split value", () => {
    expect(redactSensitiveQuery("?password=pa;ss")).toBe("?password=[REDACTED]");
    expect(redactSensitiveQuery("?a=1;token=abc;state=ok&b=2")).toBe(
      "?a=1;token=[REDACTED]&b=2",
    );
    expect(redactSensitiveFragment("#access_token=abc;def")).toBe(
      "#access_token=[REDACTED]",
    );
  });

  it("keeps a trailing semicolon after a redacted value", () => {
    expect(redactSensitiveQuery("?password=abc;")).toBe("?password=[REDACTED];");
  });
});

describe("redactUrlsInText SPA-route and semicolon fragment pairs", () => {
  const cases: Array<{ url: string; redacted: string }> = [
    { url: "https://a.com/#access_token=SECRET4", redacted: "https://a.com/#access_token=[REDACTED]" },
    { url: "https://a.com/#/cb?token=SECRET1", redacted: "https://a.com/#/cb?token=[REDACTED]" },
    { url: "https://a.com/#!/x;token=SECRET3", redacted: "https://a.com/#!/x;token=[REDACTED]" },
    { url: "https://a.com/#a=1;token=abc", redacted: "https://a.com/#a=1;token=[REDACTED]" },
    { url: "https://a.com/#state=ok&/cb?token=XYZ", redacted: "https://a.com/#state=ok&/cb?token=[REDACTED]" },
  ];

  for (const { url, redacted } of cases) {
    it(`redacts ${url}`, () => {
      expect(redactUrlsInText(`see ${url}`)).toBe(`see ${redacted}`);
    });
  }

  for (const punt of [".", ")", ";"]) {
    for (const { url, redacted } of cases) {
      it(`does not restore ${punt} after ${url}`, () => {
        const expected = punt === ";" ? `${redacted};` : redacted;
        expect(redactUrlsInText(`see ${url}${punt}`)).toBe(`see ${expected}`);
      });
    }
  }

  it("leaves non-sensitive route-prefixed fragments unchanged", () => {
    const text = "see https://example.com/#/guide/install and https://example.com/#section";
    expect(redactUrlsInText(text)).toBe(text);
  });

  it("leaves a URL with a query and a non-sensitive fragment unchanged", () => {
    const text = "see https://example.com/?x=1&a=2#section";
    expect(redactUrlsInText(text)).toBe(text);
  });
});

describe("redactUrlsInText userinfo", () => {
  it("redacts a userinfo password in running text", () => {
    expect(redactUrlsInText("see https://u:SECRET5@a.com/p")).toBe(
      "see https://u:[REDACTED]@a.com/p",
    );
  });

  it("redacts a userinfo password while keeping query pairs", () => {
    expect(redactUrlsInText("see https://user:pw@host/p?x=1")).toBe(
      "see https://user:[REDACTED]@host/p?x=1",
    );
  });

  it("redacts a bare username without a colon (often the credential itself)", () => {
    expect(redactUrlsInText("see https://user@host/p")).toBe(
      "see https://[REDACTED]@host/p",
    );
  });

  it("redacts username-only userinfo credentials in running text", () => {
    expect(redactUrlsInText("see https://ghp_AbC123@github.com/org/repo")).toBe(
      "see https://[REDACTED]@github.com/org/repo",
    );
    expect(redactUrlsInText("see https://sk_live_XXX:@api.stripe.com/")).toBe(
      "see https://[REDACTED]@api.stripe.com/",
    );
  });

  it("redacts both a userinfo password and a sensitive query", () => {
    expect(redactUrlsInText("see https://user:pw@host/?token=abc")).toBe(
      "see https://user:[REDACTED]@host/?token=[REDACTED]",
    );
  });

  it("redacts a userinfo password before trailing sentence punctuation", () => {
    expect(redactUrlsInText("see https://user:pw@host/p.")).toBe(
      "see https://user:[REDACTED]@host/p.",
    );
  });
});

describe("redactUrlsInText encoded route separators", () => {
  const cases: Array<{ url: string; redacted: string }> = [
    { url: "https://example.com/#/cb%3Ftoken=SECRET", redacted: "https://example.com/#/cb%3Ftoken=[REDACTED]" },
    { url: "https://example.com/#%2Fcb%3Ftoken=SECRET", redacted: "https://example.com/#%2Fcb%3Ftoken=[REDACTED]" },
    { url: "https://example.com/#!token=abc", redacted: "https://example.com/#!token=[REDACTED]" },
  ];

  for (const { url, redacted } of cases) {
    it(`redacts ${url}`, () => {
      expect(redactUrlsInText(`see ${url}`)).toBe(`see ${redacted}`);
    });
    it(`displayFetchUrl redacts ${url}`, () => {
      expect(displayFetchUrl(url)).toBe(redacted);
    });
  }
});

describe("displayFetchUrl userinfo", () => {
  it("redacts a userinfo password in the displayed URL", () => {
    expect(displayFetchUrl("https://user:pw@host/p?x=1")).toBe(
      "https://user:[REDACTED]@host/p?x=1",
    );
  });
});
