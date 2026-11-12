# File memory

This module is inert: it has no production callers or registered tools. Storage is user-level, with global memories in `<home>/.praana/memory` and project memories in `<home>/.praana/projects/<key>/memory`. The key is the real git root (or real cwd outside git), a readable basename plus a six-character SHA-256 suffix. Worktrees are not unified.

`createFileMemoryStore({ home, cwd, now?, fs?, findRoot?, incognito? })` requires an explicit home. Its methods are:

- `write({ scope, name, type, description, body })`: strict validation, secret refusal, advisory duplicate check, atomic upsert. Names are safe lowercase slugs; descriptions are at most 300 Unicode code points on one line; bodies are at most 2048 UTF-8 bytes. Feedback/project bodies require Why/How lines. Policy-only validation lives in `validatePolicy`.
- `read({ name, scope? })`: parsed memory; project takes precedence without a scope.
- `remove({ name, scope? })`: hard delete, including malformed or oversized regular files. Ambiguous names require an explicit scope. Symlinks/directories are refused.
- `list({ scope? } = {})`: frontmatter entries, whole-day ages and stale flags (>90 days), plus skipped count. Invalid files are skipped; disappearing files are treated as absent.
- `buildMemoryIndex({ scope? } = {})`: derives `{ text, truncated, shown, total }` from directory listings and bounded frontmatter reads, never `MEMORY.md`. It throws on unsafe directories or filesystem failures. The pure renderer is also exported from `index.ts` for already-collected `IndexEntry` values.
- `recall({ name?, query? })`: exactly one argument. Name lookup returns the parsed memory. Query lookup returns `{ ok: true, matches }`, at most five `{ name, scope, description, snippet }` records. Unique case-insensitive Unicode tokens score 9/3/1 for name/description/body; ties use updated descending, name, then scope. Empty/stop-word-only queries are rejected by `validatePolicy`.
- `refreshIndexFile(scope)`: atomically regenerates that scope's `MEMORY.md`. Returns a typed success/error result; writes and removals await it but deliberately ignore refresh failures after committing the authoritative change.

`MEMORY_POLICY`, exported by `index.ts` and `store.ts`, describes which durable observations to save and which transient or derivable information not to save.

The index selects the newest prefix across both scopes (updated descending, scope, name), then groups global before project. Caps are 200 lines and 25,600 UTF-8 bytes, including separators and the exact overflow line, excluding the fixed untrusted-data preface. Overflow capacity is reserved before selection. Ages render as `0d`, `3d`, etc. Descriptions and recall snippets are truncated to 300 code points before Markdown escaping; controls/newlines become spaces.

## Safety and concurrency

The user may symlink `.praana` or its ancestors; the real `.praana` is the containment root. Descendant directory symlinks are refused, as are symlinked memory files. Directories are created with mode 0700 and files with 0600. Reads are bounded to 64 KiB per memory and 8 KiB normalized frontmatter. Writes reject secret-shaped text rather than persisting even a redacted version, identifying only the affected fields. **Hand-edited files are not secret-scanned**; do not put secrets in memory files. The index and recall are untrusted observations, never instructions.

Atomic same-directory exclusive temp creation, file fsync and rename provide last-writer-wins replacement. Directory fsync is best effort. There are no locks: duplicate checks and `created` are advisory under races; list/read/index are not snapshots. `MEMORY.md` may briefly be stale and is never authoritative or read back. Failed writers remove only their own temp file; orphan temp files from crashed writers are ignored and are not collected.
