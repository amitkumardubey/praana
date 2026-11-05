import { describe, expect, test } from "bun:test";
import { decideRerun } from "../scripts/ci/runner-capacity.js";

const annotation = "The job was not acquired by Runner of type hosted even after multiple attempts";
const mac = (name: string) => ({ name, conclusion: "cancelled", annotations: [annotation] });
const base = { runConclusion: "failure", runAttempt: 1, jobs: [mac("macOS arm64"), mac("macOS x64")] };

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
