# Risk-Tiered Action Gating Design (Issue #303)

**Date:** 2026-08-23
**Status:** Approved
**Depends on:** #297 turn-loop hooks (`pre_tool_call`); evolves plan mode (#221)
**Related epic:** #195 (deterministic tools harness)
**Related:** #300 (validate hook — different checks, same `pre_tool_call` chain)

## Purpose

Stop forcing a plan-approve round-trip on every new task. Keep `/plan on` as
an opt-in gate. Confirm **destructive / outward** actions with a deterministic
classifier and an inline TTY prompt. Headless fails closed unless the class is
allowlisted.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Forced planning | Delete Plan-Before-Execute system-frame rule. Delete `detectPlanModeIntent`. |
| `/plan on` | Unchanged: blocks the existing mutation set until `/plan execute` or an approval word |
| Approval words | `detectPlanApproval` stays (leave an armed `/plan` only) |
| Mechanism | Always-on `pre_tool_call` hook. No new agent-facing tools. Never rewrite args |
| Confirm UX | Inline TTY `[y/N]` (same readline style as `edit.confirm`). Only `y` / `yes` proceed |
| Headless | Deny confirm-tier unless class id is in `[risk].allow` (default `[]`) |
| TTY vs allowlist | Allowlist does **not** skip interactive confirm |
| Workspace writes | `write_file` / `edit_file` / `batch_*` **inside cwd** are free |
| `edit.confirm` | Unchanged (opt-in workspace diffs) |
| Pre-block result | `{ ok: false, error }` (`isError: true`) |
| Hook order (pre) | plan → validate → **risk confirm** → write-path acquire → LSP snapshot |
| Hook order (post) | unchanged (LSP → verify → enrich → write-path release) |

Risk confirm sits **before** write-path acquire so a decline cannot leak a lock.

## Risk table

| Tier | What | TTY | Headless |
|---|---|---|---|
| Free | Reads; path tools **inside cwd**; `git_status` / `git_diff`; `git_commit`; `lsp_*`; shell that does not match below | run | run |
| Confirm | Classes listed below | prompt, then run or decline | deny unless class in `[risk].allow` |

Confirm-tier class ids (exact strings for config and errors):

| Class id | Trigger |
|---|---|
| `rm` | `shell` first real token is `rm` |
| `git_reset` | `shell` is `git reset` |
| `git_force_push` | `shell` is `git push` and any argv token is `-f`, `--force`, `--force-with-lease` (optional `=…`), or a short-flag cluster containing `f` (e.g. `-uf`) |
| `git_clean` | `shell` is `git clean` and any argv token is `--force` or a short-flag cluster containing `f` (e.g. `-f`, `-fd`, `-fdx`, `-ff`). `git clean -n` / `-d` without `f` is free |
| `gh_issue_close` | `shell` is `gh issue close` |
| `gh_pr_merge` | `shell` is `gh pr merge` |
| `package_install` | `shell` first real token is `npm` / `pnpm` / `yarn` / `bun` / `pip` / `pip3` **and** the next token (first subcommand) is `install`, `add`, or `i`. `npm run install` and `npm ci` are free |
| `write_outside_cwd` | `write_file` / `edit_file` / `batch_write` / `batch_edit`: any resolved path is outside session cwd |

First match wins. Unknown tools are free. Classifier never throws.

### Shell tokenization

- Skip leading `sudo` and `NAME=value` env prefixes.
- First real token is the command (`rm`, `git`, `gh`, `npm`, …).
- No pipeline / `&&` parsing — same as #300 first-token-only.
- `git push origin main` (no force flag) is **free**.
- `npm ci` / `bun ci` / `yarn ci` are **free** (not `install` / `add` / `i`).

### Paths outside cwd

Resolve like the path tools (`cwd` + path). Outside means the resolved absolute
path is not equal to cwd and is not under cwd (including `../` and absolute
paths). One outside path in a batch is enough.

## Config

```toml
[risk]
allow = []  # headless-only class ids permitted without a prompt
```

- Append-merge across config layers (`risk.allow`), same as `shell.allowed_paths`.
- Unknown ids: warn at load, ignore.
- Default `allow = []` (fail closed).

## Confirm callback

`HookSessionLike` grows:

```ts
confirmRisk?(
  classId: RiskClass,
  prompt: string,
): Promise<{ allowed: true } | { allowed: false; reason: "declined" | "headless" }>
```

Session implements:

- **Headless:** `{ allowed: true }` iff `classId` is in `config.risk.allow`; else `{ allowed: false, reason: "headless" }`. No prompt.
- **TTY:** `createInterface` on stdin / stderr, `Apply? [y/N] `. Only `y` / `yes` → `{ allowed: true }`; otherwise `{ allowed: false, reason: "declined" }`.
- **Throw / stdin close:** `{ allowed: false, reason: "declined" }` (do not run the tool).
- **Mutex:** serialize prompts so concurrent `Promise.all` pre-hooks cannot interleave stdin. `createConfirmLock()` in `src/risk/confirm-lock.ts`; Session holds one lock.
- **Missing `confirmRisk`:** hook fail-closes (block as `headless`).

Tests inject `confirmRisk`. The hook must not import `Session`.

Prompt shown to the user: **one line** — class id + command or resolved path.
No file contents.

Error strings (block, never rewrite args):

- Declined TTY: `User declined <class>: <command or path>`
- Headless deny: `Blocked in headless (<class>). Add it to [risk].allow to permit.`

## Plan mode

- `/plan on` still blocks `PLAN_MODE_BLOCKED_TOOLS` plus branch-creating shell
  until `/plan execute` or `detectPlanApproval`.
- Plan mode does **not** today block `rm`, force-push, `gh` close/merge, or
  installs. Those still reach risk confirm while armed.
- `turn.ts` stops calling `detectPlanModeIntent`. Headless already skipped it.
- Compiler omits the Plan-Before-Execute block for every session (the
  `planBeforeExecute` flag can be removed if nothing else uses it).

## Testing

Inject `confirmRisk` and `cwd`. No real TTY.

- Classifier table: each class hits; `sudo rm`, `FOO=1 rm`,
  `git push --force-with-lease`, `git push origin main` (free), `npm ci` (free),
  `write_file` `../x` vs `./src/x`, batch with one outside path.
- Hook: TTY decline blocks; TTY accept continues; headless deny; headless
  allowlist pass; confirm throw → decline.
- Mutex: two concurrent confirms resolve in order (fake confirm records order).
- Plan-mode still blocks `write_file` first; `rm` still reaches risk confirm
  while `/plan on`.
- Compiler: Plan-Before-Execute gone; `/plan on` + approval words still work.
- Config: unknown allow id warns; append-merge.

## Files

- Create: `src/risk/classify.ts`, `src/risk/classes.ts`,
  `src/hooks/handlers/risk.ts`
- Modify: `src/hooks/types.ts`, `src/hooks/index.ts`, `src/session.ts`,
  `src/turn.ts`, `src/compiler.ts`, `src/plan-mode.ts` (delete
  `detectPlanModeIntent`), `src/config.ts`, `src/types.ts`
- Tests: `tests/risk-classify.test.ts`, `tests/risk-hook.test.ts`; update
  `tests/plan-mode.test.ts`, `tests/compiler.test.ts`, `tests/hooks.test.ts`
- Spec: this file
- Docs: `AGENTS.md`, `ARCHITECTURE.md`, `concepts.md`; comment on #303

## Explicit non-goals

- Session-level “allow this class for the rest of the session”
- Pretty TUI dialog (readline only)
- Confirming `git_commit`, plain `git push`, general `sudo`, `docker`, `chmod`
- Treating `npm ci` / `bun ci` as `package_install`
- Expanding plan-mode’s mutation set
- Changing `edit.confirm`
- New agent-facing tools
