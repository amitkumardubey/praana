import { describe, it, expect } from "bun:test";
import {
  AmbiguousSessionPrefixError,
  SessionNotFoundError,
} from "../src/session-errors.js";
import { SessionNotFoundError as SessionReexport } from "../src/session.js";

describe("SessionNotFoundError", () => {
  it("carries the session id and a readable message", () => {
    const err = new SessionNotFoundError("sess-abc-123");
    expect(err.name).toBe("SessionNotFoundError");
    expect(err.sessionId).toBe("sess-abc-123");
    expect(err.message).toBe("Session sess-abc-123 not found.");
  });

  it("is an instance of Error", () => {
    const err = new SessionNotFoundError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SessionNotFoundError);
  });

  it("is re-exported from session.js for existing callers", () => {
    expect(SessionReexport).toBe(SessionNotFoundError);
  });
});

describe("AmbiguousSessionPrefixError", () => {
  it("lists matching ids and remains an Error subclass", () => {
    const matches = ["01AAAA0000000000000000001", "01AAAA0000000000000000002"];
    const err = new AmbiguousSessionPrefixError("01AAAA000000", matches);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AmbiguousSessionPrefixError);
    expect(err.name).toBe("AmbiguousSessionPrefixError");
    expect(err.prefix).toBe("01AAAA000000");
    expect(err.matches).toEqual(matches);
    expect(err.message).toMatch(/Ambiguous session prefix/);
    expect(err.message).toContain("01AAAA0000000000000000001");
  });
});
