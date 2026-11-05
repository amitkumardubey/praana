import { describe, expect, test } from "bun:test";
import { decideRerun } from "../scripts/ci/runner-capacity.js";
import releaseFixture from "./fixtures/ci/release-please-41862103937.json";
import nativesFixture from "./fixtures/ci/natives-41862103985.json";
import failureFixture from "./fixtures/ci/real-failure.json";

const annotation = "The job was not acquired by Runner of type hosted even after multiple attempts";
const mac = (name: string) => ({ name, conclusion: "cancelled", annotations: [annotation] });
const base = { runConclusion: "failure", runAttempt: 1, jobs: [mac("macOS arm64"), mac("macOS x64")] };

describe("recorded runner capacity decisions", () => {
  test.each([
    ["release-please 41862103937 attempt 1", releaseFixture, "rerun"],
    ["natives 41862103985 attempt 1", nativesFixture, "rerun"],
    ["genuine failure", failureFixture, "ignore"],
  ] as const)("%s", (_name, fixture, expected) => {
    expect(decideRerun(fixture).action).toBe(expected);
  });
});

describe("runner capacity decisions", () => {
  test("reruns when all failed macOS jobs were not acquired", () => {
    expect(decideRerun(base).action).toBe("rerun");
  });
  test("ignores a mixed real failure", () => {
    expect(decideRerun({ ...base, jobs: [...base.jobs, { name: "tests", conclusion: "failure", annotations: [] }] }).action).toBe("ignore");
  });
  test("alerts at the attempt cap", () => {
    expect(decideRerun({ ...base, runAttempt: 3 }).action).toBe("alert");
  });
  test("ignores successful runs", () => {
    expect(decideRerun({ ...base, runConclusion: "success" }).action).toBe("ignore");
  });
  test("excludes skipped and successful jobs", () => {
    expect(decideRerun({ ...base, jobs: [...base.jobs, { name: "publish", conclusion: "skipped", annotations: [] }, { name: "linux", conclusion: "success", annotations: [] }] }).action).toBe("rerun");
  });
  test("ignores missing annotations", () => {
    expect(decideRerun({ ...base, jobs: [{ name: "macOS", conclusion: "cancelled", annotations: [] }] }).action).toBe("ignore");
  });
  test("ignores failures with no failed jobs", () => {
    expect(decideRerun({ ...base, jobs: [] }).action).toBe("ignore");
  });
  test("accepts annotated failure jobs and honors a custom cap", () => {
    expect(decideRerun({ ...base, jobs: [{ name: "macOS", conclusion: "failure", annotations: [annotation] }], maxAttempts: 1 }).action).toBe("alert");
  });
});
