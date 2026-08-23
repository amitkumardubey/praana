# Secret Redaction Design (Issue #302)

**Date:** 2026-08-23
**Status:** Approved
**Depends on:** #297 turn-loop hooks (`post_tool_call`)
**Related epic:** #195 (deterministic tools harness)
**Related:** #300 (validate enrich — redact **after** enrich so suggestions are scanned)

## Purpose

Keep AWS / GitHub / GitLab / OpenAI / Anthropic keys, PEM blocks, and
high-entropy `KEY=value` assignments out of **tool results** (compiled prompt +
`events.jsonl` `tool_result`) and **tool-call args** (`events.jsonl` `tool_call`
+ TUI pending row). Always on. Never rewrite args the tool **executes**.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Default | Always on. No `[redact]` config |
| Tool results | `post_tool_call` walks `result` and replaces matches |
| Tool-call args | Redact a **copy** at log/TUI time; `execute` still gets original `tc.args` |
| User / agent chat | Out of v1 |
| Mechanism | Pure `redactSecrets(value)` helper. No new tools |
| `ok` / `isError` | Never flipped |
| Soft-fail | Walker / detector throw → return original value |
| Hook order (post) | LSP → verify → enrich → **redact** → write-path release |

`turn.ts` already assigns `result = post.result` before `tool_result` append and
the next compile, so result redaction covers prompt + disk.

## Walk

- Recurse objects / arrays; redact `string` leaves only.
- Depth cap **8**. Deeper strings left unchanged.
- Numbers, booleans, `null` untouched.
- First detector match wins, left-to-right on each string (global replace per detector).

## Detectors

Placeholder: `[REDACTED:<kind>]`.

| Kind | Trigger |
|---|---|
| `aws-access-key` | `AKIA` or `ASIA` + 16 alphanumeric |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` + remainder |
| `gitlab-token` | `glpat-` + remainder |
| `openai-key` | `sk-` + long token, **not** starting `sk-ant-` |
| `anthropic-key` | `sk-ant-` + remainder |
| `private-key` | `-----BEGIN` … `PRIVATE KEY-----` through matching `-----END` … `-----` (one placeholder for the whole block) |
| `key-assignment` | Identifier matching `KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD\|API_KEY` (case-insensitive) + `=` / `:` + value length ≥ 20 with mixed charset. **Exclude** hex-only git SHAs (40/64) and Crockford ULIDs (26) |

## Tool-call args

In `turn.ts` Phase 1 (before execute):

```ts
const loggedArgs = redactSecrets(tc.args) as Record<string, unknown>;
session.eventLog.append({ kind: "tool_call", payload: { …, args: loggedArgs } });
s.onToolCall?.(tc.toolCallId, tc.toolName, loggedArgs);
```

`toolDef.execute` / `pre.args` stay unredacted so the command actually runs.

`turnRecorder.recordToolCall` args: use the same redacted copy if that payload
can enter a checkpoint / prompt; otherwise original is fine if recorder stays
session-private and is not compiled. **v1: pass the redacted copy** so any
future compile of the recorder cannot leak.

## Hook

`createRedactPostToolCallHandler()`: `result: redactSecrets(ctx.result)`.
Do not import `Session`. No session methods required.

Pre-block results never enter `runPostToolCall` — skip (no secrets).

## Testing

- Each detector hits; `sk-ant-` is anthropic not openai.
- `KEY=deadbeef…` (40 hex) and a ULID do **not** match `key-assignment`.
- PEM → one placeholder.
- Nested `{ stdout: "AKIA…" }` redacts; `ok: true` unchanged; depth > 8 unchanged.
- Hook after enrich: secret in `error` or `suggestions` redacted.
- Args: logged/TUI copy redacted; execute mock still receives the raw secret.
- False-positive pass over existing fixtures (`tests/credentials.test.ts` dummies,
  sample SHAs). Fixtures use documented fakes (`AKIA` + 16 `A`s, `sk-ant-test…`).
  Never commit live keys.

## Files

- Create: `src/redact/secrets.ts`, `src/hooks/handlers/redact.ts`
- Modify: `src/hooks/index.ts` (register after validate enrich, before write-path
  release), `src/turn.ts` (redact args copy at `tool_call` log + `onToolCall` +
  recorder)
- Tests: `tests/redact-secrets.test.ts`, `tests/redact-hook.test.ts`
- Spec: this file
- Docs: `AGENTS.md`, `ARCHITECTURE.md`, `concepts.md`; comment on #302

## Explicit non-goals

- User / agent message redaction
- `[redact]` config / disable hatch
- Slack / Stripe / JWT / generic bearer
- Cognitive Memory / scorecard DB
- Rewriting files already written to disk
- Changing args the tool executes
