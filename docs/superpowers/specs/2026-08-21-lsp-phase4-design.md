# LSP Crash Restart + Multi-Root Design (Issue #11 Phase 4)

**Date:** 2026-08-21
**Status:** Implemented on `feat/ad/issue-11-lsp-phase4`
**Depends on:** Issue #11 Phase 3 / `2026-08-14-lsp-phase3-design.md`
**Related epic:** Issue #195 (deterministic tools harness)

## Purpose

Harden the Phase 2–3 LSP client: respawn a dead language-server process with
exponential backoff, and route files to the most specific workspace root
(JS package-manager member or nested git root) instead of a single session
git root. Agent-facing `lsp_*` tools do not change.

Phase 4 does **not** ship signature help, extra languages, WorkspaceEdit
resource ops, command-only actions, or completion insert/apply.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Roots | Most-specific of: JS workspace member dir, nested git root of the file, session git root |
| Path allowlist | Still the **session** git root (or cwd). Extra roots partition that tree; no sibling repos |
| Process model | One `LspClient` per `(root, serverKey)`. Not `workspace/didChangeWorkspaceFolders` |
| Crash | Process `exit` / spawn `error`. Request `timeout` is not a crash |
| Retry | Transparent **one** replay after respawn + `didOpen` of known docs |
| Budget | Max **3** restarts **per client key**. Backoff **1s, 2s, 4s** |
| Config | No new `[lsp]` keys |
| Concurrency | Cap **8** processes; LRU evict idle. Test injection via `maxClients` |
| JS/TS sharing | Collapse `javascript` onto `typescript` when JS falls back to the TS argv |
| Shutdown | Session `shutdown()` must not restart |

## Architecture

```
Session
  └── LspManager (session-scoped)
        ├── WorkspaceRootResolver  (cached members per git/session root)
        └── Map<(root, serverKey) → LspClient>
              ├── restartCount / exhausted
              ├── lastUsedAt / inflight
              └── open docs restored via didOpen after respawn
```

No new tools. `prepareDocument` / RPC calls go through `withClient`.

## Workspace root resolver

`resolveLspRoot(absPath, sessionRoot): string` in `src/lsp/workspace-roots.ts`.

1. Paths outside `sessionRoot` → return `sessionRoot` (caller still uses
   `inWorkspace` to reject).
2. Nested git: `git rev-parse --show-toplevel` from `dirname(absPath)` only
   when that directory **is** a git work tree (`isGitRepo`). `findGitRoot`
   returning the input cwd on failure is **not** treated as a git root.
   A git root strictly inside `sessionRoot` is a candidate.
3. Discover workspace members **once per anchor** (git root of the file if
   in a repo, else `sessionRoot`):
   - `package.json` `workspaces` (string[] or `{ packages: string[] }`)
   - `pnpm-workspace.yaml` `packages` via `Bun.YAML.parse` (skip on failure)
4. Expand globs: `*` = one path segment, `**` = recursive; honor `!` excludes.
   Keep only existing directories that contain a `package.json`.
5. Return the **longest** matching member prefix; else nested git root;
   else `sessionRoot`.

Non-goals: Nx, Turbo, Lerna, Cargo/Go workspaces.

## Client keying

`clientKey(root, serverKey)` where `serverKey` is the `[lsp.servers]` key
actually used (`typescript` when JS falls back). `didOpen` still sends the
file’s language id (`javascript` vs `typescript`).

`mapLocations` / `inWorkspace` stay on **session** `workspaceRoot` so
cross-package `lsp_definition` results remain visible.

## Crash restart

Constants (not config): `MAX_RESTARTS = 3`, `BACKOFF_MS = [1000, 2000, 4000]`.

`withClient(absPath, fn)`:

1. Resolve root; get or start client for `(root, serverKey)`.
2. If stored client `isClosed` and budget remains: backoff, spawn, restore
   docs, increment `restartCount`.
3. If budget exhausted: `unavailable` for that key for the rest of the session.
4. Run `fn(client)`. On crash (`unavailable` + `isClosed`, or process-exited
   message): if this wrapper has not already retried and budget remains,
   restart, restore docs, drop code-action cache entries under that root,
   replay `fn` **once**. Second crash in the same wrapper → map error.

Restore: for each still-existing `openDocs` path whose `resolveLspRoot`
equals this root, `didOpen` from disk (same as first open). Then
`syncDocument` on the retried call may `didChange`.

Intentional `shutdown()` sets `shutDown` and must not respawn.

Timeouts leave the client usable and do **not** increment `restartCount`.

Sleep is injectable (`sleep` / `now` on `LspManagerOptions`) so tests do not
wait real backoff.

## LRU

Default `maxClients = 8` (constructor override for tests). After a successful
spawn, if `clients.size > maxClients`, shut down the least-recently-used
**idle** client (not the one just started, not one with inflight `withClient`).
`lastUsedAt` updates on each `withClient` entry.

## Testing

Deterministic fake stdio LSP (`tests/fixtures/fake-lsp-server.ts`).

- `FAKE_LSP_EXIT_ON=<method>` — exit(1) after reading that request
- Optional event log for `didOpen` counts

Coverage: workspace member / pnpm yaml / nested git / outside-session;
crash then success; three crashes then `unavailable`; timeout ≠ restart;
two package dirs → two `rootUri`s; LRU with `maxClients: 2`; stale code
action after restart; no restart after `shutdown`.

## Documentation updates

- This spec; Phase 2/3 specs point follow-on here
- `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md`
- GitHub #11 comment; leave issue open for remaining follow-ons

## Explicit non-goals / deferred (stay on #11)

- Full `WorkspaceEdit` resource ops (create / rename / delete)
- `workspace/executeCommand` / command-only code actions
- Signature help
- Language mapping beyond TS/JS
- Completions insert/apply
- Bundling or auto-installing language servers
- CLI fallback formatters
- Nx / Turbo / Lerna project graphs

## Acceptance criteria

1. Dead language server: the same tool call succeeds after respawn, or
   returns `unavailable` after 3 restarts for that client key.
2. Files in different workspace packages or nested git repos use different
   `rootUri` processes.
3. Session `shutdown` kills all children and does not restart.
4. Focused LSP tests pass without a real language server; typecheck clean.
