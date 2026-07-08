import { describe, it, expect } from "bun:test";
import { SessionNotFoundError } from "../src/session.js";

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
});
