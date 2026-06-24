/** Information-density kinds used for weighted context pressure. */
export type SectionDensityKind =
  | "pinned_infra"
  | "active_request"
  | "decision"
  | "constraint"
  | "plan"
  | "open_error"
  | "narrative"
  | "file"
  | "finding"
  | "activity"
  | "fixed_error"
  | "verbatim_turn"
  | "turn_digest"
  | "artifact_card"
  | "activity_entry"
  | "memory_digest"
  | "active_state"
  | "peripheral_state";

/**
 * Hardcoded density weights — lower = more compressible, counts less toward pressure.
 * These values directly gate compaction behavior (pressure mode escalation and
 * checkpoint trimming). No config knob yet; tune here or add `[context_engine.density]`
 * when empirical calibration is needed.
 */
export const DENSITY_WEIGHTS: Record<SectionDensityKind, number> = {
  pinned_infra: 1.0,
  active_request: 1.0,
  decision: 1.0,
  constraint: 1.0,
  plan: 1.0,
  open_error: 0.8,
  narrative: 0.6,
  file: 0.6,
  finding: 0.25,
  /** Checkpoint "Recent activity" section — same weight as scored activity_entry units. */
  activity: 0.25,
  fixed_error: 0.25,
  verbatim_turn: 0.9,
  turn_digest: 0.4,
  artifact_card: 0.4,
  /** Scored ContextUnit objects of type activity_entry — same weight as checkpoint activity. */
  activity_entry: 0.25,
  memory_digest: 1.0,
  active_state: 1.0,
  peripheral_state: 0.6,
};

export function effectiveTokens(
  rawTokens: number,
  kind: SectionDensityKind,
): number {
  return rawTokens * DENSITY_WEIGHTS[kind];
}

export function sumEffectiveTokens(
  sections: { tokens: number; kind: SectionDensityKind }[],
): number {
  return sections.reduce(
    (sum, s) => sum + effectiveTokens(s.tokens, s.kind),
    0,
  );
}
