export const RISK_CLASSES = [
  "rm",
  "git_reset",
  "git_force_push",
  "git_clean",
  "gh_issue_close",
  "gh_pr_merge",
  "package_install",
  "write_outside_cwd",
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

export const RISK_CLASS_SET = new Set<string>(RISK_CLASSES);

export type RiskConfirmResult =
  | { allowed: true }
  | { allowed: false; reason: "declined" | "headless" };

export interface RiskHit {
  class: RiskClass;
  detail: string;
}

export function isRiskClass(id: string): id is RiskClass {
  return RISK_CLASS_SET.has(id);
}
