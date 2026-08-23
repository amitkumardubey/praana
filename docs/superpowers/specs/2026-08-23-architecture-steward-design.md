# Architecture Steward Design

## Goal

Help PRAANA keep repositories easy for coding agents and people to navigate and
change safely. The feature reduces context load by surfacing a small, relevant
architectural slice before an edit, then advises when the resulting change
drifts from the repository's intended boundaries.

The Architecture Steward is advisory in its first release. It never blocks an
edit and must distinguish explicit rule violations from low-confidence
inferences.

## Source of Truth

The project may opt in through two complementary artifacts:

1. `.praana/architecture.json` is the machine-readable, human-owned
   architectural contract. It contains:
   - a schema version;
   - named modules, their path globs, purpose, and entry points;
   - public API paths;
   - allowed and forbidden module dependency directions;
   - test locations; and
   - human-authored rationale and constraints.
2. `docs/architecture-map.md` is a human- and agent-readable navigation map.
   PRAANA generates only explicitly fenced sections containing module
   summaries, direct dependency summaries, common entry points, and
   module-to-test associations.

PRAANA must preserve all text outside generated fences. It does not rewrite
human decisions, constraints, or rationale. The generated section includes a
source hash and generation timestamp.

The manifest stays intentionally small. It records stable boundaries and
navigation facts rather than duplicating implementation detail.

## Session Workflow

### Before an edit

For each proposed mutating edit, the steward resolves the affected path to a
declared module. It supplies a compact Architecture Brief containing only:

- the module's purpose and entry point;
- applicable public API and dependency constraints;
- immediate neighboring modules relevant to the edit; and
- the closest relevant test paths.

If no manifest exists, the steward may provide inferred navigation but must
label it as inferred and must not invent architectural rules.

### After an edit

The steward re-analyzes changed files and their immediate import and dependent
edges. It reports only material outcomes:

- an explicit forbidden dependency;
- a newly introduced dependency cycle;
- a direct bypass of a declared public API;
- a misplaced or missing declared test association; or
- generated-map drift.

The generated section of `docs/architecture-map.md` refreshes automatically
when the code model changes. Findings include evidence, affected paths, and a
suggested repair. Explicit manifest violations are high confidence;
heuristic observations are informational.

### On demand

An `/architecture` command analyzes the full repository and may initialize a
draft manifest plus navigation map. Every inferred field in the draft is
marked as a proposal that requires user approval before becoming a rule.

## Components

`architecture/manifest.ts`
: Parses, validates, and version-migrates `.praana/architecture.json`.

`architecture/graph.ts`
: Builds and caches module import/export edges from existing Tree-sitter code
intelligence, using LSP resolution when available.

`architecture/brief.ts`
: Resolves the smallest architecture brief applicable to an edit target.

`architecture/analyze.ts`
: Checks manifest rules, detects cycles, and classifies findings by confidence.

`architecture/map.ts`
: Renders and safely refreshes fenced generated sections in the Markdown map.

`architecture/service.ts`
: Provides the public facade used by session initialization, mutating-tool
hooks, post-edit processing, and the slash command.

The service will integrate with existing code-intelligence, LSP, configuration,
tool-hook, and post-edit verification systems instead of duplicating them.

## Performance and Failure Behavior

The graph is keyed by file content hashes and updated incrementally after
edits. Full-repository analysis happens only through `/architecture` or
initial map generation. Normal edit flows analyze the touched paths and nearby
edges only.

The feature is opt-in initially through `[architecture] enabled = false`.
Brief injection, post-edit analysis, and generated-map refresh are separately
configurable.

Missing native code intelligence, unresolved dynamic imports, unsupported
languages, malformed manifests, and incomplete LSP results produce an
`unavailable` or `incomplete` result. They never become architecture
violations and never stop the agent's requested edit.

## Validation

Tests must cover:

- manifest schema validation and version migration;
- path-to-module resolution and dependency-rule matching;
- cycle detection;
- selection and compact rendering of architecture briefs;
- incremental changed-file analysis;
- safe preservation of human-authored Markdown around generated fences;
- draft manifests marking inferred values as proposals; and
- graceful behavior when Tree-sitter or LSP is unavailable.

Success means an agent gets a focused navigation and boundary brief before an
edit, explicit rules reliably identify regressions afterwards, the generated
map remains current without modifying authored guidance, and the feature adds
minimal prompt and runtime overhead.

## Non-goals

- Enforcing architecture rules or blocking edits.
- Inferring human intent as a hard rule.
- Maintaining an exhaustive code encyclopedia.
- Replacing existing search, LSP, verification, or Adaptive Context systems.
