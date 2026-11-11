import { describe, expect, it } from "bun:test";
import http from "node:http";
import {
  MAX_REDIRECTS,
  assessRedirect,
  classifyAddress,
  createPinnedLookup,
  fetchGuarded,
  guardUrl,
  type GuardTransport,
  type HostLookup,
} from "../src/tools/web/ssrf.js";

/** Resolver that must not run. A literal or blocked name that reaches DNS fails the test. */
const noDns: HostLookup = {
  async resolve() {
    throw new Error("DNS should not be called");
  },
};

function dns(addresses: string[]): HostLookup {
  return {
    async resolve() {
      return addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
    },
  };
}

const publicDns = dns(["8.8.8.8"]);

async function blocked(url: string, kind: string, lookup: HostLookup = noDns): Promise<void> {
  const result = await guardUrl(url, { lookup });
  expect(result.ok, url).toBe(false);
  if (!result.ok) expect(result.reason.toLowerCase()).toContain(kind);
}

describe("classifyAddress literal forms", () => {
  const cases: Array<{ input: string; kind: string | null }> = [
    { input: "127.0.0.1", kind: "loopback" },
    { input: "127.0.0.2", kind: "loopback" },
    { input: "127.255.255.254", kind: "loopback" },
    { input: "127.1", kind: "loopback" },
    { input: "127.0.1", kind: "loopback" },
    { input: "2130706433", kind: "loopback" },
    { input: "0x7f.1", kind: "loopback" },
    { input: "0x7f000001", kind: "loopback" },
    { input: "0177.0.0.1", kind: "loopback" },
    { input: "0177.0.0.01", kind: "loopback" },
    { input: "0.0.0.0", kind: "unspecified" },
    { input: "0.0.0.1", kind: "unspecified" },
    { input: "0.255.255.255", kind: "unspecified" },
    { input: "0", kind: "unspecified" },
    { input: "10.0.0.1", kind: "private" },
    { input: "10.255.255.255", kind: "private" },
    { input: "172.16.0.1", kind: "private" },
    { input: "172.31.255.255", kind: "private" },
    { input: "192.168.0.1", kind: "private" },
    { input: "192.168.255.255", kind: "private" },
    { input: "169.254.0.1", kind: "link-local" },
    { input: "169.254.169.254", kind: "link-local" },
    { input: "169.254.255.255", kind: "link-local" },
    { input: "100.64.0.1", kind: "cgnat" },
    { input: "100.127.255.254", kind: "cgnat" },
    { input: "224.0.0.1", kind: "multicast" },
    { input: "239.255.255.255", kind: "multicast" },
    { input: "240.0.0.1", kind: "reserved" },
    { input: "255.255.255.255", kind: "reserved" },
    { input: "::1", kind: "loopback" },
    { input: "::", kind: "unspecified" },
    { input: "fc00::1", kind: "private" },
    { input: "fd12:3456::1", kind: "private" },
    { input: "fe80::1", kind: "link-local" },
    { input: "ff02::1", kind: "multicast" },
    { input: "::ffff:127.0.0.1", kind: "loopback" },
    { input: "::ffff:7f00:1", kind: "loopback" },
    { input: "::ffff:169.254.169.254", kind: "link-local" },
    { input: "::ffff:a9fe:a9fe", kind: "link-local" },
    { input: "::ffff:10.0.0.1", kind: "private" },
    { input: "::ffff:0.0.0.0", kind: "unspecified" },
    { input: "::7f00:1", kind: "loopback" },
    { input: "::127.0.0.1", kind: "loopback" },
    { input: "::10.1.2.3", kind: "private" },
    { input: "2002:7f00:1::", kind: "loopback" },
    { input: "64:ff9b::7f00:1", kind: "loopback" },
    { input: "64:ff9b::a00:1", kind: "private" },
    { input: "[::1]", kind: "loopback" },
    { input: "[fe80::1]", kind: "link-local" },
    { input: "8.8.8.8", kind: null },
    { input: "1.1.1.1", kind: null },
    { input: "172.15.255.255", kind: null },
    { input: "172.32.0.1", kind: null },
    { input: "100.63.255.255", kind: null },
    { input: "100.128.0.1", kind: null },
    { input: "9.9.9.9", kind: null },
    // IANA IPv4 special-purpose ranges that are not globally reachable.
    { input: "192.0.0.1", kind: "reserved" },
    { input: "192.0.2.1", kind: "documentation" },
    { input: "198.18.0.1", kind: "benchmarking" },
    { input: "198.19.255.254", kind: "benchmarking" },
    { input: "198.51.100.1", kind: "documentation" },
    { input: "203.0.113.1", kind: "documentation" },
    { input: "192.88.99.1", kind: "reserved" },
    // Just outside those ranges, so the guards do not over-block.
    { input: "198.17.255.255", kind: null },
    { input: "198.20.0.1", kind: null },
    { input: "198.51.99.1", kind: null },
    { input: "198.51.101.1", kind: null },
    { input: "203.0.112.1", kind: null },
    { input: "203.0.114.1", kind: null },
    { input: "192.0.1.1", kind: null },
    { input: "192.0.3.1", kind: null },
    // IANA IPv6 special-purpose ranges that are not globally reachable.
    { input: "100::1", kind: "reserved" },
    { input: "2001:db8::1", kind: "documentation" },
    { input: "2001:2::1", kind: "benchmarking" },
    { input: "2001::1", kind: "reserved" },
    { input: "64:ff9b:1::1", kind: "reserved" },
    { input: "3fff::1", kind: "documentation" },
    { input: "::ffff:8.8.8.8", kind: null },
    { input: "::ffff:808:808", kind: null },
    { input: "64:ff9b::808:808", kind: null },
    { input: "2606:4700:4700::1111", kind: null },
    { input: "2001:4860:4860::8888", kind: null },
  ];

  for (const c of cases) {
    it(`${c.kind ? "blocks" : "allows"} literal ${c.input}`, () => {
      const found = classifyAddress(c.input);
      if (c.kind === null) {
        expect(found).toBeNull();
      } else {
        expect(found).toBe(c.kind);
      }
    });
  }
});

describe("guardUrl", () => {
  const blockedUrls: Array<{ url: string; kind: string; lookup?: HostLookup }> = [
    { url: "http://127.0.0.1/", kind: "loopback" },
    { url: "http://127.0.0.1:80/", kind: "loopback" },
    { url: "http://2130706433/", kind: "loopback" },
    { url: "http://0x7f.1/", kind: "loopback" },
    { url: "http://0x7f000001/", kind: "loopback" },
    { url: "http://127.1/", kind: "loopback" },
    { url: "http://0177.0.0.1/", kind: "loopback" },
    { url: "http://[::1]/", kind: "loopback" },
    { url: "http://[::ffff:127.0.0.1]/", kind: "loopback" },
    { url: "http://[::ffff:7f00:1]/", kind: "loopback" },
    { url: "http://[::127.0.0.1]/", kind: "loopback" },
    { url: "http://0.0.0.0/", kind: "unspecified" },
    { url: "http://0/", kind: "unspecified" },
    { url: "http://[::]/", kind: "unspecified" },
    { url: "http://10.1.2.3/", kind: "private" },
    { url: "http://172.16.5.5/", kind: "private" },
    { url: "http://192.168.1.1/", kind: "private" },
    { url: "http://[fc00::1]/", kind: "private" },
    { url: "http://[fd00::1]/", kind: "private" },
    { url: "http://169.254.169.254/", kind: "link-local" },
    { url: "http://169.254.169.254/latest/meta-data", kind: "link-local" },
    { url: "http://[::ffff:169.254.169.254]/", kind: "link-local" },
    { url: "http://[fe80::1]/", kind: "link-local" },
    { url: "http://100.64.0.1/", kind: "cgnat" },
    { url: "http://100.100.0.1/", kind: "cgnat" },
    { url: "http://224.0.0.1/", kind: "multicast" },
    { url: "http://[ff02::1]/", kind: "multicast" },
    { url: "http://240.0.0.1/", kind: "reserved" },
    { url: "http://255.255.255.255/", kind: "reserved" },
    { url: "http://[2002:7f00:1::]/", kind: "loopback" },
    { url: "http://[64:ff9b::7f00:1]/", kind: "loopback" },
    { url: "http://localhost/", kind: "blocked hostname" },
    { url: "http://localhost./", kind: "blocked hostname" },
    { url: "http://LOCALHOST/", kind: "blocked hostname" },
    { url: "http://foo.localhost/", kind: "blocked hostname" },
    { url: "http://foo.local/", kind: "blocked hostname" },
    { url: "http://bar.internal/", kind: "blocked hostname" },
    { url: "http://metadata.google.internal/", kind: "blocked hostname" },
    { url: "http://metadata.google.internal./computeMetadata/v1/", kind: "blocked hostname" },
    { url: "http://evil.com@127.0.0.1/", kind: "userinfo" },
    { url: "https://user:pass@example.com/a", kind: "userinfo", lookup: publicDns },
    { url: "ftp://example.com/", kind: "only http and https" },
    { url: "file:///etc/passwd", kind: "only http and https" },
    { url: "http://example.com/", kind: "private", lookup: dns(["10.0.0.1"]) },
    { url: "http://example.com/", kind: "private", lookup: dns(["8.8.8.8", "10.0.0.1"]) },
    { url: "http://example.com/", kind: "loopback", lookup: dns(["::1"]) },
    { url: "http://example.com/", kind: "link-local", lookup: dns(["8.8.8.8", "169.254.169.254"]) },
    { url: "http://missing.example/", kind: "dns", lookup: dns([]) },
    { url: "not a url", kind: "invalid url" },
    { url: "http://", kind: "invalid url" },
  ];

  for (const [i, c] of blockedUrls.entries()) {
    it(`blocks ${c.url} (${c.kind}) #${i}`, async () => {
      await blocked(c.url, c.kind, c.lookup ?? noDns);
    });
  }

  it("does not treat a lookalike suffix as a blocked name", async () => {
    const result = await guardUrl("https://localhost.example.com/a", { lookup: publicDns });
    expect(result.ok).toBe(true);
    const localCom = await guardUrl("https://example.local.com/", { lookup: publicDns });
    expect(localCom.ok).toBe(true);
    const internalCom = await guardUrl("https://internal.example.com/", { lookup: publicDns });
    expect(internalCom.ok).toBe(true);
  });

  it("pins the first public address and keeps the original URL", async () => {
    const result = await guardUrl("https://example.com/docs/a?page=1", {
      lookup: dns(["1.1.1.1", "8.8.8.8"]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pin.address).toBe("1.1.1.1");
      expect(result.pin.family).toBe(4);
      expect(result.pin.url.pathname).toBe("/docs/a");
      expect(result.pin.url.search).toBe("?page=1");
    }
  });

  it("allows a public IPv6 literal without DNS", async () => {
    const result = await guardUrl("https://[2606:4700:4700::1111]/dns-query", { lookup: noDns });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pin.family).toBe(6);
      expect(result.pin.address.toLowerCase()).toContain("2606:4700:4700");
    }
  });

  it("allows a mapped public IPv4", async () => {
    const result = await guardUrl("http://[::ffff:8.8.8.8]/", { lookup: noDns });
    expect(result.ok).toBe(true);
  });

  it("allows an https URL whose DNS is entirely public", async () => {
    const result = await guardUrl("https://example.com/", { lookup: publicDns });
    expect(result.ok).toBe(true);
  });
});

describe("redirects and DNS rebinding", () => {
  it("refuses an https to http downgrade before connecting", () => {
    const from = new URL("https://example.com/start");
    const next = assessRedirect(from, "http://example.com/insecure");
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason.toLowerCase()).toContain("downgrade");
  });

  it("allows http to https and resolves relative locations", () => {
    const from = new URL("https://example.com/dir/page");
    const up = assessRedirect(from, "https://example.com/next");
    expect(up.ok).toBe(true);
    const rel = assessRedirect(from, "/other");
    expect(rel.ok).toBe(true);
    if (rel.ok) expect(rel.url.href).toBe("https://example.com/other");
  });

  it("refuses a non-http redirect scheme", () => {
    const next = assessRedirect(new URL("https://example.com/"), "ftp://example.com/x");
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason.toLowerCase()).toContain("scheme");
  });

  it("refuses a redirect that adds userinfo", () => {
    const next = assessRedirect(new URL("https://example.com/"), "https://user:pw@example.com/");
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason.toLowerCase()).toContain("userinfo");
  });

  function scripted(hops: Record<string, { status: number; location?: string; body?: string }>): {
    transport: GuardTransport;
    seen: string[];
  } {
    const seen: string[] = [];
    const transport: GuardTransport = {
      async exchange(pin) {
        seen.push(pin.address);
        const hop = hops[pin.url.hostname];
        if (!hop) throw new Error(`unexpected host ${pin.url.hostname}`);
        return {
          status: hop.status,
          headers: hop.location ? { location: hop.location } : {},
          body: new TextEncoder().encode(hop.body ?? ""),
        };
      },
    };
    return { transport, seen };
  }

  it("blocks a redirect to the metadata address and does not connect to it", async () => {
    const { transport, seen } = scripted({
      "public.example": { status: 302, location: "http://169.254.169.254/latest/meta-data" },
    });
    const result = await fetchGuarded("http://public.example/start", {
      lookup: dns(["8.8.8.8"]),
      transport,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain("link-local");
    expect(seen).toEqual(["8.8.8.8"]);
  });

  it("blocks a redirect chain that goes public then private", async () => {
    const { transport, seen } = scripted({
      "one.example": { status: 302, location: "http://two.example/next" },
      "two.example": { status: 302, location: "http://10.1.2.3/secret" },
    });
    const lookup: HostLookup = {
      async resolve(hostname) {
        if (hostname === "one.example") return [{ address: "1.1.1.1", family: 4 }];
        if (hostname === "two.example") return [{ address: "8.8.8.8", family: 4 }];
        throw new Error(`unexpected ${hostname}`);
      },
    };
    const result = await fetchGuarded("http://one.example/", { lookup, transport });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain("private");
    expect(seen).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(seen).not.toContain("10.1.2.3");
  });

  it("connects to the first validated address when a later lookup is private", async () => {
    let calls = 0;
    const lookup: HostLookup = {
      async resolve() {
        calls += 1;
        if (calls === 1) return [{ address: "8.8.8.8", family: 4 }];
        return [{ address: "10.0.0.1", family: 4 }];
      },
    };
    const seen: string[] = [];
    const transport: GuardTransport = {
      async exchange(pin) {
        seen.push(pin.address);
        return { status: 200, headers: {}, body: new TextEncoder().encode("ok") };
      },
    };
    const result = await fetchGuarded("http://rebind.example/item", { lookup, transport });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address).toBe("8.8.8.8");
      expect(result.finalUrl).toBe("http://rebind.example/item");
    }
    expect(seen).toEqual(["8.8.8.8"]);
    expect(calls).toBe(1);
  });

  it("refuses a second independent resolution that flipped to a private address", async () => {
    let calls = 0;
    const lookup: HostLookup = {
      async resolve() {
        calls += 1;
        if (calls === 1) return [{ address: "8.8.8.8", family: 4 }];
        return [{ address: "10.0.0.1", family: 4 }];
      },
    };
    const first = await guardUrl("http://rebind.example/", { lookup });
    expect(first.ok).toBe(true);
    const second = await guardUrl("http://rebind.example/", { lookup });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason.toLowerCase()).toContain("private");
  });

  it("stops after the redirect cap", async () => {
    const transport: GuardTransport = {
      async exchange(pin) {
        const n = Number(pin.url.hostname.split(".")[0]);
        const next = n + 1;
        return {
          status: 302,
          headers: { location: `http://${next}.example/` },
          body: new Uint8Array(),
        };
      },
    };
    const lookup: HostLookup = {
      async resolve() {
        return [{ address: "8.8.8.8", family: 4 }];
      },
    };
    const result = await fetchGuarded("http://1.example/", { lookup, transport });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain("redirect");
    expect(MAX_REDIRECTS).toBe(5);
  });

  it("follows an http to https redirect and returns the final URL", async () => {
    const { transport } = scripted({
      "one.example": { status: 302, location: "https://one.example/done" },
      "one.example/": { status: 200, body: "done" },
    });
    const real: GuardTransport = {
      async exchange(pin) {
        if (pin.url.protocol === "https:" && pin.url.pathname === "/done") {
          return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("done") };
        }
        return transport.exchange(pin);
      },
    };
    const result = await fetchGuarded("http://one.example/start", {
      lookup: publicDns,
      transport: real,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalUrl).toBe("https://one.example/done");
      expect(result.status).toBe(200);
      expect(new TextDecoder().decode(result.body)).toBe("done");
    }
  });
});

describe("pinned lookup", () => {
  it("returns the validated address and never a later DNS answer", async () => {
    const lookup = createPinnedLookup({ address: "8.8.8.8", family: 4 });
    const all = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      lookup("rebind.example", { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses as Array<{ address: string; family: number }>);
      });
    });
    expect(all).toEqual([{ address: "8.8.8.8", family: 4 }]);

    const one = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("rebind.example", {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(one).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("connects to the pinned address in Bun while the Host stays the requested name", async () => {
    const server = http.createServer((req, res) => {
      res.end(`host=${req.headers.host ?? ""}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            protocol: "http:",
            hostname: "pin.example",
            port: addr.port,
            path: "/pinned",
            method: "GET",
            lookup: createPinnedLookup({ address: "127.0.0.1", family: 4 }),
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c as Buffer));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(body.startsWith("host=pin.example:")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
