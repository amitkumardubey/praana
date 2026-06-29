export type Constraint =
  | { kind: "length"; value: number }
  | { kind: "percentage"; value: number }
  | { kind: "ratio"; numerator: number; denominator: number }
  | { kind: "min"; value: number }
  | { kind: "max"; value: number }
  | { kind: "fill"; weight: number };

export function lengthConstraint(n: number): Constraint {
  return { kind: "length", value: n };
}

export function percentageConstraint(n: number): Constraint {
  return { kind: "percentage", value: n };
}

export function ratioConstraint(numerator: number, denominator: number): Constraint {
  return { kind: "ratio", numerator, denominator };
}

export function minConstraint(n: number): Constraint {
  return { kind: "min", value: n };
}

export function maxConstraint(n: number): Constraint {
  return { kind: "max", value: n };
}

export function fillConstraint(weight = 1): Constraint {
  return { kind: "fill", weight };
}

export type LayoutDirection = "vertical" | "horizontal";

export interface Layout {
  constraints: Constraint[];
  direction: LayoutDirection;
}

export function createLayout(
  constraints: Constraint[],
  opts?: { direction?: LayoutDirection }
): Layout {
  return {
    constraints,
    direction: opts?.direction ?? "vertical",
  };
}
