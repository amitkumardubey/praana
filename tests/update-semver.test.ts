import { describe, it, expect } from "bun:test";
import { isNewer, parseReleaseTuple } from "../src/update/semver.js";

describe("parseReleaseTuple", () => {
  it("parses leading v and ignores prerelease", () => {
    expect(parseReleaseTuple("v0.15.1")).toEqual([0, 15, 1]);
    expect(parseReleaseTuple("0.15.1-dev.abc123.dirty")).toEqual([0, 15, 1]);
    expect(parseReleaseTuple("1.2.3")).toEqual([1, 2, 3]);
  });

  it("returns null for garbage", () => {
    expect(parseReleaseTuple("")).toBeNull();
    expect(parseReleaseTuple("not-a-version")).toBeNull();
  });
});

describe("isNewer", () => {
  it("is true only when latest numeric tuple is greater", () => {
    expect(isNewer("0.16.0", "0.15.1")).toBe(true);
    expect(isNewer("v0.15.2", "v0.15.1")).toBe(true);
    expect(isNewer("0.15.1", "0.15.1")).toBe(false);
    expect(isNewer("0.15.1", "0.15.1-dev.abc")).toBe(false);
    expect(isNewer("0.16.0", "0.15.1-dev.abc")).toBe(true);
    expect(isNewer("0.15.1", "0.16.0-dev")).toBe(false);
  });
});
