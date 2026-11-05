export interface CapacityJob {
  name: string;
  status?: string;
  conclusion: string | null;
  annotations: string[];
}

export interface CapacityRun {
  runConclusion: string | null;
  runAttempt: number;
  jobs: CapacityJob[];
  maxAttempts?: number;
}

export function jobsSettled(jobs: { status?: string; conclusion: string | null }[]): boolean {
  return jobs.every((job) =>
    !["queued", "in_progress", "waiting", "pending"].includes(job.status ?? "") &&
    (job.conclusion !== null || job.status === "completed")
  );
}

export function decideRerun({ runConclusion, runAttempt, jobs, maxAttempts = 3 }: CapacityRun): { action: "rerun" | "alert" | "ignore" | "wait"; reason: string } {
  if (!jobsSettled(jobs)) return { action: "wait", reason: "Jobs have not settled" };
  if (runConclusion !== "failure") return { action: "ignore", reason: "Run did not fail" };
  const failed = jobs.filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped");
  if (failed.length === 0 || !failed.every((job) =>
    (job.conclusion === "cancelled" || job.conclusion === "failure") &&
    job.annotations.some((annotation) => annotation.includes("was not acquired by Runner"))
  )) return { action: "ignore", reason: "Not all failed jobs have runner capacity annotations" };
  if (runAttempt >= maxAttempts) return { action: "alert", reason: "Runner capacity retry attempts exhausted" };
  return { action: "rerun", reason: "All failed jobs have runner capacity annotations" };
}
