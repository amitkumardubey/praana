# PRAANA Rust v2 Configuration Specification

**Status:** Normative implementation specification

**Configuration schema version:** 1

**Date:** 2026-08-31

Provider registry, model-catalog trust, capability profiles, credentials, setup,
login, and logout are owned by
`docs/RUST_V2_PROVIDER_CATALOG_CREDENTIAL_SPEC.md`. Configuration stores only
non-secret provider/model/protocol/endpoint choices.

## 1. Scope and Authority

This document is the sole normative authority for Rust v2 configuration. It
defines accepted keys, types, defaults, source discovery, layer precedence,
merge behavior, environment and command-line overrides, path resolution,
validation, secret handling, reload behavior, session metadata, errors,
fixtures, and acceptance tests.

Other Rust v2 specifications own the behavior that consumes an effective value.
They MUST refer to a key in this document and MUST NOT declare another default,
alias, compatibility key, merge rule, or configuration enum. A numeric value in
another specification is a protocol or safety constant unless that text
explicitly names a key from this document.

Rust v2 has no compatibility obligation for TypeScript configuration. In
particular, old `compiler`, `context_engine`, `tiers`, `shell`, `edit`, `native`,
`lsp`, `verify`, `skills`, `ui`, `consolidation`, and legacy `memory` keys are not
aliases. They are unknown keys under schema version 1.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## 2. Configuration Lifecycle

The configuration pipeline is exactly:

```text
construct schema defaults
  -> discover source files
  -> parse each source strictly
  -> validate each partial layer
  -> normalize layer-owned paths
  -> merge layers over defaults in precedence order
  -> apply non-secret environment field overrides
  -> apply command-line field overrides
  -> validate the complete effective configuration
  -> serialize canonical effective JSON
  -> calculate config_digest_sha256
```

No provider credential is part of this pipeline. Credentials are resolved after
request admission through the credential store or the provider-specific
credential environment variable.

Configuration loading is fail-closed. A present source that cannot be parsed or
validated prevents session creation or resume. The loader never ignores an
unknown key, substitutes a default for an invalid supplied value, or partially
uses a malformed source.

## 3. Source Discovery and Precedence

### 3.1 Roots

`PRAANA_HOME` selects the application data root. It is a source-location
environment variable, not a configuration field. If absent, the root is
`~/.praana`. It is expanded and normalized by the path rules in section 7 before
source discovery. An empty or invalid `PRAANA_HOME` is fatal.

The defaults for `session.root`, `logging.directory`, and
`memory.options.db_path` are constructed relative to this application root
before file layers merge. Their literals in section 5.1 show the absent-
`PRAANA_HOME` case. An explicitly supplied value for any of those fields is not
rebased merely because `PRAANA_HOME` is set.

The session cwd is the absolute normalized cwd supplied by the CLI or IPC
session-create command. It is captured before reading project configuration.
Rust v2 does not search cwd ancestors for a configuration file.

### 3.2 Discovered sources

When neither `--config` nor `PRAANA_CONFIG` is supplied, existing files are read
in this order, from lowest to highest precedence:

1. `<PRAANA_HOME>/praana.config.json`
2. `<PRAANA_HOME>/config.toml`
3. `<session-cwd>/praana.config.json`
4. `<session-cwd>/praana.config.toml`

A missing discovered file is normal and produces no warning. A path that exists
but is not a regular file, is a symlink, cannot be read, exceeds 1 MiB, or has an
unsupported encoding is fatal. Source files MUST be UTF-8 without a BOM.

### 3.3 Explicit source

`--config <path>` selects exactly one source and suppresses all four discovered
sources. If `--config` is absent, non-empty `PRAANA_CONFIG` does the same. The
CLI selector wins when both are present.

An explicit path MUST end in `.toml` or `.json`; extension guessing is forbidden.
It is resolved relative to the process cwd, not the session cwd. The selected
path must be an existing regular non-symlink file and every parse/read error is
fatal. Defaults, environment field overrides, and CLI field overrides still
apply around the explicit source.

### 3.4 Complete precedence

The complete precedence from lowest to highest is:

1. Schema defaults in section 5.
2. Global JSON.
3. Global TOML.
4. Session-cwd JSON.
5. Session-cwd TOML.
6. Non-secret environment field overrides in section 8.
7. Command-line field overrides in section 9.

The explicit-source rule replaces items 2 through 5 with the one selected file.
Provider credential precedence is outside this list.

## 4. Parsing and Merge Rules

### 4.1 Partial source documents

Each source is a partial schema-v1 object. `config_schema_version`, when
present, MUST be integer `1`. Omitting it means version 1. A different integer is
`CONFIG_VERSION_UNSUPPORTED`; a non-integer is `CONFIG_INVALID_TYPE`.

TOML is parsed as TOML 1.0. JSON is parsed with strict duplicate-key rejection.
JSON comments, trailing commas, NaN, and infinity are invalid. JSON `null` is
not a deletion operator and is rejected for every config field. TOML duplicate
keys/tables and JSON duplicate keys are fatal.

### 4.2 Merge

Merge behavior is exactly:

- Objects and TOML tables deep-merge recursively by key.
- A supplied scalar replaces the lower-precedence scalar.
- Every array replaces the lower-precedence array in full. Arrays never append,
  prepend, or union across layers.
- The dynamic `providers.<id>.extra_headers` map replaces as one complete map.
  Its individual entries do not deep-merge.
- An explicit empty array or empty `extra_headers` map clears lower-precedence
  entries.
- Type changes are invalid; they do not replace a value of another type.

Array replacement is security-significant for `risk.allow` and
`tools.allowed_paths`: a project layer can remove a broader global allowlist by
setting `[]`, and no hidden append behavior can retain it.

### 4.3 Validation timing

Unknown keys and local type/range errors are rejected in the source that
contains them before merge. Cross-field constraints are validated after all
layers and overrides. A lower layer may therefore provide one side of a valid
pair and a higher layer the other, but the final pair must be valid.

## 5. Exact Initial Schema and Defaults

### 5.1 Effective default TOML

This is the complete schema-v1 default value when `PRAANA_HOME` is absent. It is
normative TOML, except that the empty `llm.provider` and `llm.model` values
represent setup-required state as defined in section 6.3. When `PRAANA_HOME` is
present, only the three root-relative defaults named in section 3.1 change.

```toml
config_schema_version = 1

[history]
mode = "append"
compact_at = 0.60
compact_clear_at = 0.45
compact_mass_fraction = 0.50
reasoning_replay = "active"
artifact_inline_tokens = 800
artifact_batch_inline_tokens = 1600
artifact_preview_tokens = 160
safety_margin_ratio = 0.03
safety_margin_min_tokens = 512
summary_segment_max_tokens = 2400
handoff_max_tokens = 1600
compactor_provider = ""
compactor_model = ""
compactor_timeout_ms = 60000
compactor_max_output_tokens = 4096

[state]
active_max_tokens = 4096
auto_hydrate = true
auto_hydrate_max = 3
idle_soft_after_turns = 20
idle_hard_after_turns = 50
automation_policy_version = "state-lexical-v1"

[llm]
provider = ""
protocol = "auto"
model = ""
context_window = 0
unsafe_allow_context_window_increase = false
max_output_tokens = 8192
min_output_tokens = 256
reasoning_effort = "medium"
reasoning_reserve_tokens = 0
request_timeout_ms = 120000
fallback_provider = ""
fallback_protocol = "auto"
fallback_model = ""
fallback_context_window = 0

[providers.openai]
base_url = "https://api.openai.com/v1"

[providers.openai.extra_headers]

[providers.openrouter]
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.extra_headers]

[turn]
max_steps = 25
max_attempts = 3

[tools]
shell_enabled = true
allowed_paths = []
max_parallel_calls = 8
max_spawned_processes = 4
default_timeout_ms = 60000
shell_timeout_ms = 30000
shell_max_timeout_ms = 600000

[risk]
allow = []

[circuit]
loop_threshold = 3
max_tokens = 0
max_wall_ms = 0

[session]
root = "~/.praana/sessions"
retention_days = 0
orphan_retention_days = 7
incognito = false
shutdown_grace_ms = 3000

[logging]
level = "info"
format = "text"
stderr = true
file = false
directory = "~/.praana/logs"
rotate_bytes = 10485760
keep_files = 5

[memory]
plugin = "none"

[memory.options]
db_path = "~/.praana/plugins/builtin-sqlite/memory.db"
extraction = true
digest_max_tokens = 1200
recall_limit = 10
llm_contradictions = false

[memory.timeouts]
open_ms = 2000
start_ms = 3000
recall_ms = 3000
remember_ms = 2000
retract_ms = 2000
pin_ms = 2000
feedback_ms = 1000
stats_ms = 1000
end_ms = 30000
close_ms = 2000
```

There is no `[prompt_injection]` table or similarly named escape hatch.
Prompt-injection defenses are runtime policy, not user-configurable authority.

### 5.2 Types, ranges, and enums

Every string is UTF-8, rejects NUL, and is trimmed only where this section says
so. Integer fields accept decimal integers only. Numeric ratios accept TOML
integer/float or JSON number syntax but must be finite. Bounds are inclusive
unless stated otherwise.

| Key | Type and accepted values |
|---|---|
| `config_schema_version` | Integer; exactly `1`. |
| `history.mode` | Enum; exactly `append`. `engine` is rejected. |
| `history.compact_at` | Ratio in `0.40..=0.95`. |
| `history.compact_clear_at` | Ratio in `0.10..0.90`, strictly less than `compact_at`. |
| `history.compact_mass_fraction` | Ratio in `0.05..=1.00`. |
| `history.reasoning_replay` | Enum; exactly `active` in schema v1. |
| `history.artifact_inline_tokens` | Integer `64..=65536`. |
| `history.artifact_batch_inline_tokens` | Integer `64..=262144`; must be at least `artifact_inline_tokens`. |
| `history.artifact_preview_tokens` | Integer `64..=4096`. |
| `history.safety_margin_ratio` | Ratio `0.00..=0.10`. |
| `history.safety_margin_min_tokens` | Integer `0..=8192`. |
| `history.summary_segment_max_tokens` | Integer `256..=16384`. |
| `history.handoff_max_tokens` | Integer `256..=16384`. |
| `history.compactor_provider` | Empty, `openai`, or `openrouter`; trim ASCII edge whitespace. |
| `history.compactor_model` | Empty or 1..256 bytes after ASCII-edge trim. |
| `history.compactor_timeout_ms` | Integer `1000..=300000`. |
| `history.compactor_max_output_tokens` | Integer `256..=16384`. |
| `state.active_max_tokens` | Integer `256..=16384`. |
| `state.auto_hydrate` | Boolean. |
| `state.auto_hydrate_max` | Integer `0..=32`; zero disables selection without changing `auto_hydrate`. |
| `state.idle_soft_after_turns` | Integer `1..=100000`. |
| `state.idle_hard_after_turns` | Integer `1..=100000`; strictly greater than `idle_soft_after_turns`. |
| `state.automation_policy_version` | Exactly `state-lexical-v1` in schema v1. |
| `llm.provider` | Empty, `openai`, or `openrouter`; ASCII-edge trimmed. |
| `llm.protocol` | `auto`, `openai-chat-v1`, or `openai-responses-v1`. |
| `llm.model` | Empty or 1..256 UTF-8 bytes after ASCII-edge trim. |
| `llm.context_window` | Integer `0`, meaning trusted catalog/profile resolution, or `2048..=2147483647` explicit tokens. |
| `llm.unsafe_allow_context_window_increase` | Boolean. |
| `llm.max_output_tokens` | Integer `1..=1048576`. |
| `llm.min_output_tokens` | Integer `1..=1048576`; no greater than `max_output_tokens`. |
| `llm.reasoning_effort` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `llm.reasoning_reserve_tokens` | Integer `0..=1048576`; zero delegates to the resolved capability profile. |
| `llm.request_timeout_ms` | Integer `1000..=600000`. |
| `llm.fallback_provider` | Empty, `openai`, or `openrouter`. |
| `llm.fallback_protocol` | `auto`, `openai-chat-v1`, or `openai-responses-v1`. |
| `llm.fallback_model` | Empty or 1..256 UTF-8 bytes after trim. |
| `llm.fallback_context_window` | Same domain as `llm.context_window`. |
| `providers.openai.base_url` | URL satisfying section 7.4. |
| `providers.openrouter.base_url` | URL satisfying section 7.4. |
| `providers.<id>.extra_headers` | Map of 0..32 validated HTTP header names to strings of at most 4096 bytes each. |
| `turn.max_steps` | Integer `1..=1000`. |
| `turn.max_attempts` | Integer `1..=3`, including the initial attempt. |
| `tools.shell_enabled` | Boolean. |
| `tools.allowed_paths` | Array of at most 64 unique path strings. |
| `tools.max_parallel_calls` | Integer `1..=32`. |
| `tools.max_spawned_processes` | Integer `1..=8`. |
| `tools.default_timeout_ms` | Integer `10..=60000`. |
| `tools.shell_timeout_ms` | Integer `10..=600000`; no greater than `shell_max_timeout_ms`. |
| `tools.shell_max_timeout_ms` | Integer `10..=600000`. |
| `risk.allow` | Unique array containing only `rm`, `git_reset`, `git_force_push`, `git_clean`, `gh_issue_close`, `gh_pr_merge`, `package_install`, or `write_outside_cwd`. |
| `circuit.loop_threshold` | Integer `2..=100`. The Nth qualifying attempt is blocked. |
| `circuit.max_tokens` | Integer `0..=9007199254740991`; zero disables the budget. |
| `circuit.max_wall_ms` | Integer `0..=604800000`; zero disables the budget. |
| `session.root` | Path string resolved by section 7. |
| `session.retention_days` | Integer `0..=36500`; zero means unlimited closed-session retention. |
| `session.orphan_retention_days` | Integer `0..=36500`. |
| `session.incognito` | Boolean. |
| `session.shutdown_grace_ms` | Integer `0..=10000`. |
| `logging.level` | `trace`, `debug`, `info`, `warn`, or `error`. |
| `logging.format` | `text` or `json`. |
| `logging.stderr` | Boolean. |
| `logging.file` | Boolean. |
| `logging.directory` | Path string resolved by section 7. |
| `logging.rotate_bytes` | Integer `1048576..=1073741824`. |
| `logging.keep_files` | Integer `1..=100`. |
| `memory.plugin` | `none` or `builtin:sqlite`. |
| `memory.options.db_path` | Plugin-owned path satisfying section 7.3. |
| `memory.options.extraction` | Boolean. |
| `memory.options.digest_max_tokens` | Integer `64..=16384`. |
| `memory.options.recall_limit` | Integer `1..=50`. |
| `memory.options.llm_contradictions` | Boolean. |

`memory.timeouts` fields are integers with these exact ranges:

| Key | Range | Default |
|---|---:|---:|
| `open_ms` | `1..=10000` | 2000 |
| `start_ms` | `1..=10000` | 3000 |
| `recall_ms` | `1..=10000` | 3000 |
| `remember_ms` | `1..=10000` | 2000 |
| `retract_ms` | `1..=10000` | 2000 |
| `pin_ms` | `1..=10000` | 2000 |
| `feedback_ms` | `1..=5000` | 1000 |
| `stats_ms` | `1..=5000` | 1000 |
| `end_ms` | `1..=60000` | 30000 |
| `close_ms` | `1..=5000` | 2000 |

### 5.3 Nullable effective field

`llm.temperature_milli` is the only nullable field in complete effective
schema-v1 JSON. When supplied in a source it is
an integer `0..=2000`, representing temperature multiplied by 1000. When absent,
the provider field is omitted. It is represented as JSON null in canonical
effective JSON. A model capability may reject a present value before network
access.

No other accepted field is nullable in the effective configuration. Every source
document remains partial as section 4.1 defines; defaults fill every omitted
field.

## 6. Cross-Field and Phase Validation

### 6.1 Provider/protocol combinations

`protocol = auto` resolves to `openai-responses-v1` for `provider = openai` and
`openai-chat-v1` for `provider = openrouter`. The resolved protocol, not `auto`,
is recorded in model selection and provider attempts.

Accepted initial combinations are:

| Provider | Protocol |
|---|---|
| `openai` | `openai-chat-v1` or `openai-responses-v1` |
| `openrouter` | `openai-chat-v1` |

OpenRouter Responses is rejected before credential lookup or network access.

### 6.2 Context windows

`llm.context_window = 0` requires a trusted exact model profile or provider
catalog value. If neither exists, session request admission fails with
`ADMISSION_CONTEXT_WINDOW_UNKNOWN`; the loader does not invent a number.

An explicit value may lower a trusted known context window. A value above a
trusted known window is valid only when
`llm.unsafe_allow_context_window_increase = true`. Such a session emits
`CONFIG_UNSAFE_CONTEXT_WINDOW` and records the override in admission telemetry.
The flag does not make an otherwise unknown model trusted; it only authorizes an
explicit nonzero value.

The same rules apply to the fallback context window. Empty fallback provider and
model mean no fallback. Otherwise provider and model must both be non-empty and
the combination must satisfy section 6.1.

### 6.3 Setup-required state

The default empty `llm.provider` and `llm.model` permit only `praana doctor`,
setup, login/logout, config inspection, and config validation. Creating or
resuming a provider-capable session fails with `CONFIG_SETUP_REQUIRED`. A
credential environment variable never selects a provider or model implicitly.

### 6.4 Compactor pair

`history.compactor_provider` and `history.compactor_model` are both empty or
both non-empty. A configured pair uses the provider combinations in section
6.1. Empty means `auto`: resolve the active session provider, protocol, exact
model, revision rule, endpoint fingerprint, and credential source as the
compactor target. Session creation then requires that exact capability profile
to be `SelfCompactionCapability::Validated` and support the strict
`praana.compaction_candidate.v1` schema. If it does not, creation fails with
`CONFIG_COMPACTOR_REQUIRED` and instructs the user to set both compactor fields.
A non-empty configured pair is validated for a trusted context window, strict
schema output, credentials, and compactor admission during session creation.
Thus a provider-capable session never starts and later discovers at the pressure
threshold that no compactor exists. Resolution performs no network completion
and does not silently select a different model.

### 6.5 History mode and reasoning replay

`append` is the sole schema-v1 `history.mode` value. `engine` is Phase 10
research and is rejected as `CONFIG_VALUE_NOT_IMPLEMENTED` until a later config
schema and projection specification explicitly accept it.

`active` is the sole schema-v1 `history.reasoning_replay` value. It preserves
provider-native continuation only for the active tool cycle. Setting
`llm.reasoning_effort = off` produces no reasoning continuation but does not
change the replay policy. Proposed `none`, `all`, and server-ID replay modes are
future values and are rejected.

### 6.6 Phase gates

The schema is implemented incrementally without silently accepting dead keys:

- Phase 1 implements source loading, validation, snapshots, digests, session
  paths, append mode, and logging.
- Phase 2 activates `[llm]`, `[providers]`, `turn.max_attempts`, and hard request
  admission. Before Phase 2, a provider-capable session command returns
  `CONFIG_FEATURE_NOT_IMPLEMENTED`.
- Phase 3 activates `[turn]`, `[tools]`, `[risk]`, `[circuit]`, and History
  artifact keys.
- Phase 4 activates `[state]` and session retention/orphan maintenance.
- Phase 5 activates History pressure/compaction and configured-compactor keys.
- Phase 6 accepts `memory.plugin = builtin:sqlite` and activates memory options
  and timeouts. Before Phase 6, only `memory.plugin = none` is accepted.

The complete parser still rejects unknown keys from day one. A phase may accept
the schema-v1 default for a not-yet-active subsystem only when no runtime command
can observe that subsystem. Any non-default request for an unavailable feature
returns `CONFIG_FEATURE_NOT_IMPLEMENTED`.

## 7. Path and URL Normalization

### 7.1 General path algorithm

For each path-valued field in each source layer:

1. Reject NUL, an empty string, and a string over 4096 UTF-8 bytes.
2. Expand only an initial exact `~/` against the current user's home directory.
   Bare `~`, `~user`, `${HOME}`, `$HOME`, `%USERPROFILE%`, and arbitrary
   environment interpolation are not expanded.
3. If still relative, resolve against the directory containing that source
   file. A path from an environment or CLI field override resolves against the
   session cwd.
4. Lexically remove `.` and resolve `..`; reject traversal above the filesystem
   root.
5. Normalize separators to the platform-native absolute path in runtime values.
   Canonical effective JSON uses `/` separators and an uppercase Windows drive
   letter.
6. Do not require the final path to exist unless its consuming subsystem says
   so. Before opening, that subsystem validates symlinks and nearest-existing
   ancestors under its own filesystem safety contract.

No path is normalized relative to whichever layer happened to win after merge;
normalization occurs while the owning layer and source directory are known.

### 7.2 Session and tool paths

`tools.allowed_paths` entries are normalized by the same algorithm, de-duplicated
after platform path comparison, and stored in supplied order. The session cwd is
always the primary workspace root and is not duplicated into the array.

### 7.3 Built-in memory storage boundary

The built-in plugin storage root is fixed at
`<PRAANA_HOME>/plugins/builtin-sqlite`. It is not configurable in schema v1.
`memory.options.db_path` MUST resolve to a file path strictly beneath
that root. It may not equal the root or resolve beneath `session.root` through a
symlink. Its location relative to the session cwd grants no project access: the
capability remains the exact DB path only. The default resolves to
`<PRAANA_HOME>/plugins/builtin-sqlite/memory.db`.

The resolved database file, SQLite `-wal`, `-shm`, and rollback-journal sidecars,
and plugin-owned migration temporaries in that one parent directory are the
entire built-in filesystem capability. The plugin receives no project, core
session, artifact, event-log, arbitrary-home, or general filesystem access.

### 7.4 Provider URL algorithm

Provider base URLs are ASCII-edge trimmed and parsed as absolute URLs. They:

- use `https`, except `http` is allowed only for an IP loopback address or the
  exact host `localhost`;
- contain no username, password, query, or fragment;
- preserve a path prefix after RFC 3986 dot-segment removal;
- remove trailing `/` bytes; and
- do not end in `/chat/completions` or `/responses`.

The normalized URL is stored in canonical effective JSON. The provider adapter
appends its one exact endpoint.

## 8. Environment Overrides and Credentials

### 8.1 Field overrides

Only these environment variables override config fields:

| Environment variable | Effective field | Parsing |
|---|---|---|
| `PRAANA_PROVIDER` | `llm.provider` | Exact enum after ASCII-edge trim. |
| `PRAANA_PROTOCOL` | `llm.protocol` | Exact enum after ASCII-edge trim. |
| `PRAANA_MODEL` | `llm.model` | Trim and validate as model string. |
| `PRAANA_CONTEXT_WINDOW` | `llm.context_window` | Unsigned base-10 integer. |
| `PRAANA_MAX_OUTPUT_TOKENS` | `llm.max_output_tokens` | Unsigned base-10 integer. |
| `PRAANA_REASONING_EFFORT` | `llm.reasoning_effort` | Exact enum. |
| `PRAANA_INCOGNITO` | `session.incognito` | `true`, `false`, `1`, or `0`. |
| `PRAANA_DEBUG` | `logging.level` | If true, set `debug`; if false, no override. |

An empty listed variable is ignored. A non-empty invalid value is fatal; it is
not ignored. Environment variable names are case-sensitive on Unix and
case-insensitive on Windows according to the operating system environment API.
No generic `PRAANA_<DOTTED_KEY>` mechanism exists.

### 8.2 Credential variables

`OPENAI_API_KEY` and `OPENROUTER_API_KEY` are credential fallbacks for an
already selected provider. They are never copied into configuration, canonical
effective JSON, the config digest, session metadata, logs, tool environments, or
fixtures. OpenRouter never falls back to `OPENAI_API_KEY`.

The credential store is likewise not a config source. Changing a credential
does not change `config_digest_sha256`.

## 9. Command-Line Overrides

Initial command-line field overrides are:

| CLI argument | Effective field |
|---|---|
| `--provider <id>` | `llm.provider` |
| `--protocol <id>` | `llm.protocol` |
| `--model <id>` | `llm.model` |
| `--context-window <tokens>` | `llm.context_window` |
| `--reasoning <level>` | `llm.reasoning_effort` |
| `--max-output-tokens <tokens>` | `llm.max_output_tokens` |
| `--max-steps <count>` | `turn.max_steps` |
| `--incognito` | `session.incognito = true` |
| `--debug` | `logging.level = debug` |

The same type, range, combination, and unsafe-window rules apply. There is no
command-line override that enables `engine`, external memory plugins, arbitrary
provider headers, or a secret config value.

## 10. Secret Prohibition

Configuration files and non-secret overrides MUST NOT contain credentials.
There are no accepted keys named `api_key`, `token`, `secret`, `password`,
`authorization`, `cookie`, `credential`, or `private_key`, at any depth.
Unknown-key validation rejects such a key without logging its value.

`extra_headers` additionally rejects, case-insensitively:

```text
authorization
proxy-authorization
cookie
set-cookie
host
content-length
content-type
accept
user-agent
http-referer
x-title
x-api-key
api-key
```

Header names must match the HTTP token grammar. Header values reject CR, LF,
NUL, the case-insensitive prefix `Bearer `, PEM private-key markers, and known
provider-key detector matches. This validation cannot prove arbitrary prose is
not a secret; users MUST use the credential store or exact credential
environment variable.

Errors and warnings include source path, line/column when available, and dotted
key, but never the rejected value for a secret-like key/header. Debug logging
does not weaken this rule.

### 10.1 Logging sinks

`logging.level` filters tracing events before either sink. `text` is one
human-readable LF-terminated record; `json` is one compact JSON object per LF
with timestamp, level, target, event name, and already-redacted structured
fields. Neither format serializes arbitrary `Debug` values.

When `logging.stderr` is true, records go to stderr only. Stdout remains provider
or IPC command output. When `logging.file` is true, the file is exactly
`<logging.directory>/praana.log`, created privately. Before a write that would
make it exceed `logging.rotate_bytes`, close and rename `.N` to `.N+1` from high
to low, rename the base to `.1`, remove generations above
`logging.keep_files`, and open a new base file. Rename/remove failures disable
the file sink with one stderr warning; they do not fail canonical session
durability. If both sinks are false, structured command/UI errors still surface
through their normal channels but tracing records are discarded.

Logs never include credentials, complete provider request/response bodies,
opaque reasoning, config source contents, raw tool arguments/results, memory
bodies, or raw artifact bodies. `PRAANA_DEBUG` changes level only; it does not
enable prompt/transcript dumps.

### 10.2 Allowed paths, risk, and circuit consumption

The session cwd is always an allowed workspace root. Each normalized
`tools.allowed_paths` entry adds one explicit root for built-in file reads,
writes, searches, test cwd, and shell cwd after normal symlink containment.
Writing outside the session cwd still carries risk class `write_outside_cwd`
even when the path is an allowed root.

`risk.allow` applies only to non-interactive/headless confirmation. A listed
class may proceed after all other validation; an unlisted class fails closed.
TTY mode still prompts and deny remains the default regardless of this array.

`circuit.loop_threshold` blocks the threshold qualifying attempt, as the Tool
Runtime specifies. `circuit.max_tokens` and `circuit.max_wall_ms` are headless
session budgets; zero disables only that budget. TTY ignores those two budgets
but still applies the loop threshold. No circuit setting bypasses validation,
risk, path containment, cancellation, or provider admission.

## 11. Memory Selection and Incognito

`memory.plugin = none` creates the no-memory boundary: no plugin object, storage,
embedding runtime, bootstrap, extraction, maintenance, completion, or memory
tool registration.

`session.incognito = true` MUST select that exact same no-memory boundary before
plugin construction, regardless of the configured `memory.plugin`. Core receives
the same `MemorySelection::None`, the same absent bootstrap, and the same absent
tool capabilities as explicit `plugin = none`. No plugin `open`, `start`, `end`,
or `close` method is called. Incognito does not create a wrapper plugin, pass an
`incognito` DTO field, or open the configured DB read-only.

The configured value remains in canonical effective JSON for honest metadata,
but the runtime memory selection records `none_incognito`. Core conversation,
history, compaction, StateGraph, artifacts, resume, and session search behavior
is byte-for-byte identical at the memory boundary to explicit no-memory mode.

## 12. Reload and Mutability

### 12.1 No live reload in schema v1

Rust v2 schema 1 has no file watcher and no in-place `reload` command. Once a
session process has loaded an effective configuration, editing a source file has
no effect on that process. A request to reload returns
`CONFIG_RELOAD_UNSUPPORTED`.

Configuration is loaded anew on process start and by `session.new` before the
replacement session is created. `session.resume` also loads current sources
before opening the canonical session. Resume then applies the exact field rules
in section 12.3; already durable decisions are never rewritten.

### 12.2 Runtime commands are not config mutation

Model/reasoning selection, TUI theme, thinking visibility, and other typed
settings commands use `RUST_V2_UI_CONTRACT.md`. Baseline `settings.patch` is
part of IPC v1 and is not capability-negotiated. These commands do not
edit an in-memory `ConfigV1` or rewrite a config source. A model/reasoning change
uses the canonical protocol boundary. Setup may atomically write one selected
user config file only while no session turn is active, then creates a new
effective configuration through the full loader.

`risk.allow`, path permissions, history policy, memory plugin selection,
timeouts, session root, and logging sinks cannot be patched through generic IPC
settings in schema v1.

### 12.3 Resume with a changed digest

The creation digest remains immutable session metadata. After loading current
sources, resume constructs the actually applied runtime configuration:

| Fields | Resume rule |
|---|---|
| `config_schema_version` | Must remain 1. |
| `session.root` | Use the creation snapshot value for the already located session; a current value is used only to discover sessions before open and for new sessions. |
| `session.incognito` | Logical OR of creation and current values. Once a canonical session was created incognito, resume can never expose it to memory. |
| `logging.*`, `session.retention_days`, `session.orphan_retention_days`, `session.shutdown_grace_ms` | Use current values for the new process. |
| Every other field, including `history.*`, `llm.*`, `providers.*`, `turn.*`, `tools.*`, `risk.*`, `circuit.*`, `state.*`, and `memory.*` | Use the creation snapshot value. Apply a source-file change only by creating `session.new`; runtime model/reasoning commands remain separately evented protocol operations. |

Canonicalize the newly loaded current-source candidate before freezing and call
its digest `loaded_config_digest_sha256`. Canonicalize the applied composite
after the table above and call its digest `runtime_config_digest_sha256`. If the
loaded digest differs from the creation digest:

- the session opens only after current config validation succeeds;
- metadata exposes `creation_config_digest_sha256`,
  `loaded_config_digest_sha256`, `runtime_config_digest_sha256`, and a changed
  flag;
- one user-visible warning `CONFIG_CHANGED_SINCE_CREATE` is emitted;
- the warning lists changed dotted keys but no old/new values; and
- no prior or future operation in this canonical session uses an ignored
  session-semantic source-file change.

`history.mode` must still be `append`. A future schema or projection value cannot
be used to reinterpret an existing schema-2 session.

## 13. Canonical Effective JSON and Digest

### 13.1 Snapshot

Before creating sequence-1 `SessionStarted`, core writes
`config.snapshot.json` in the new session directory. It is the complete resolved
schema-v1 object after defaults, normalization, environment field overrides, and
CLI field overrides. It contains no source paths, credential values, credential
environment names, provider headers added by authentication, runtime settings,
or timestamps.

The JSON object mirrors section 5.1. Keys are lower snake case. Path strings use
section 7 canonical JSON form. `llm.temperature_milli` is always present and is
JSON null when unset. Empty maps and arrays are present. Numbers are integers
except the four ratio fields, which use their shortest exact JSON decimal.

The file is serialized as RFC 8785 canonical JSON followed by one LF. It is
created with the same private permissions and immutable creation semantics as
`meta.json`.

### 13.2 Digest

```text
config_digest_sha256 = SHA256(
    RFC8785(canonical effective JSON object without the trailing LF)
)
```

The digest is 64 lowercase hexadecimal characters. `meta.json` and protocol
`SessionStarted` store `config_schema_version = 1` and this digest. Their values
must agree with each other and the snapshot bytes. Mismatch prevents mutating
resume.

The digest records behavior selection, not source provenance. Two source stacks
that resolve to the same effective object produce the same digest. A credential
rotation produces the same digest.

## 14. Errors and Warnings

### 14.1 Fatal errors

| Code | Condition |
|---|---|
| `CONFIG_SOURCE_INVALID` | Explicit/discovered present source is missing, non-regular, symlinked, unreadable, over 1 MiB, or invalid UTF-8. |
| `CONFIG_PARSE` | TOML/JSON syntax, duplicate key, BOM, comment, trailing comma, or invalid JSON number. |
| `CONFIG_VERSION_UNSUPPORTED` | Supplied schema version is not 1. |
| `CONFIG_UNKNOWN_KEY` | Any key/table is not in section 5. |
| `CONFIG_INVALID_TYPE` | Supplied value has the wrong JSON/TOML type or JSON null. |
| `CONFIG_INVALID_VALUE` | Enum, range, length, uniqueness, URL, or cross-field constraint fails. |
| `CONFIG_VALUE_NOT_IMPLEMENTED` | Recognized future enum value such as `history.mode = engine` is not accepted. |
| `CONFIG_FEATURE_NOT_IMPLEMENTED` | A non-default feature is requested before its implementation phase. |
| `CONFIG_PATH_INVALID` | Path expansion/normalization fails. |
| `CONFIG_PATH_OUTSIDE_PLUGIN_ROOT` | Built-in memory DB escapes its fixed plugin-owned root. |
| `CONFIG_SECRET_FORBIDDEN` | Secret-like key/header/value appears in configuration. |
| `CONFIG_SETUP_REQUIRED` | Provider-capable session requested with empty provider/model. |
| `CONFIG_COMPACTOR_REQUIRED` | Neither the auto-resolved active model nor the explicit compactor pair satisfies trusted context-window, credentials, and strict compaction-schema requirements. |
| `CONFIG_SNAPSHOT_MISMATCH` | Session snapshot, metadata, or digest disagree. |
| `CONFIG_RELOAD_UNSUPPORTED` | Live reload or generic config patch requested. |

Fatal config errors use process exit code 78 for a direct CLI invocation. IPC
maps them through its normal structured configuration/setup error without
echoing a rejected value.

### 14.2 Warnings

Only these schema-v1 configuration warnings exist:

| Code | Condition |
|---|---|
| `CONFIG_UNSAFE_CONTEXT_WINDOW` | Explicit trusted-window increase was authorized. |
| `CONFIG_CHANGED_SINCE_CREATE` | Runtime resume digest differs from creation digest. |
| `CONFIG_PERMISSIONS_BROAD` | An existing config file is readable by other users where the platform can determine that fact. |

Broad permissions do not make a non-secret config invalid, but the warning
recommends user-only access. A suspected credential in the file is fatal, not a
permissions warning. There are no deprecation or ignored-key warnings because
Rust v2 does not accept old aliases.

## 15. Future Keys and Rejected Values

The following future designs are explicitly rejected by schema v1. They are not
accepted keys or values:

- `history.mode = engine`, any `engine` table, and context-unit scoring keys.
- `history.reasoning_replay = none|all` and server response-ID continuation.
- External memory plugin paths/protocols, semantic memory, embeddings, model
  downloads, and vector dimensions.
- Providers other than OpenAI and OpenRouter, including Azure profile fields.
- `[lsp]`, `[verify]`, `[skills]`, `[ui]`, and general tool-plugin tables.
- Ratatui theme, mouse, animation, icon, cache, transcript-page, and rendering
  settings. Phase 9 uses typed UI settings and fixed bounds until a later config
  schema explicitly adopts them.
- IPC frame, queue, restart, page, and backpressure bounds.
- Provider `previous_response_id`/server-side storage optimization.
- Arbitrary environment-to-key mapping, includes, profiles, interpolation,
  command substitution, and remote config URLs.

An occurrence is `CONFIG_UNKNOWN_KEY` or `CONFIG_VALUE_NOT_IMPLEMENTED`; it is
never retained as an ignored future option. Accepting one requires updating this
document, incrementing the config schema when compatibility requires it, and
adding fixtures in the same change.

## 16. Required Fixtures

Fixtures live under `tests/fixtures/rust-v2/config/v1/`. Tests read committed
fixtures and never rewrite them.

### 16.1 `defaults.toml`

This file is byte-for-byte the TOML block in section 5.1 with one final LF.

### 16.2 `defaults.effective.json`

This fixture is RFC 8785 canonical JSON for the defaults after replacing `~`
with deterministic fixture home `/home/test`, using fixture cwd
`/work/project`, and adding the required nullable optional field. Its semantic
shape is:

```json
{
  "circuit": {"loop_threshold": 3, "max_tokens": 0, "max_wall_ms": 0},
  "config_schema_version": 1,
  "history": {"artifact_batch_inline_tokens": 1600, "artifact_inline_tokens": 800, "artifact_preview_tokens": 160, "compact_at": 0.6, "compact_clear_at": 0.45, "compact_mass_fraction": 0.5, "compactor_max_output_tokens": 4096, "compactor_model": "", "compactor_provider": "", "compactor_timeout_ms": 60000, "handoff_max_tokens": 1600, "mode": "append", "reasoning_replay": "active", "safety_margin_min_tokens": 512, "safety_margin_ratio": 0.03, "summary_segment_max_tokens": 2400},
  "llm": {"context_window": 0, "fallback_context_window": 0, "fallback_model": "", "fallback_protocol": "auto", "fallback_provider": "", "max_output_tokens": 8192, "min_output_tokens": 256, "model": "", "protocol": "auto", "provider": "", "reasoning_effort": "medium", "reasoning_reserve_tokens": 0, "request_timeout_ms": 120000, "temperature_milli": null, "unsafe_allow_context_window_increase": false},
  "logging": {"directory": "/home/test/.praana/logs", "file": false, "format": "text", "keep_files": 5, "level": "info", "rotate_bytes": 10485760, "stderr": true},
  "memory": {"options": {"db_path": "/home/test/.praana/plugins/builtin-sqlite/memory.db", "digest_max_tokens": 1200, "extraction": true, "llm_contradictions": false, "recall_limit": 10}, "plugin": "none", "timeouts": {"close_ms": 2000, "end_ms": 30000, "feedback_ms": 1000, "open_ms": 2000, "pin_ms": 2000, "recall_ms": 3000, "remember_ms": 2000, "retract_ms": 2000, "start_ms": 3000, "stats_ms": 1000}},
  "providers": {"openai": {"base_url": "https://api.openai.com/v1", "extra_headers": {}}, "openrouter": {"base_url": "https://openrouter.ai/api/v1", "extra_headers": {}}},
  "risk": {"allow": []},
  "session": {"incognito": false, "orphan_retention_days": 7, "retention_days": 0, "root": "/home/test/.praana/sessions", "shutdown_grace_ms": 3000},
  "state": {"active_max_tokens": 4096, "auto_hydrate": true, "auto_hydrate_max": 3, "automation_policy_version": "state-lexical-v1", "idle_hard_after_turns": 50, "idle_soft_after_turns": 20},
  "tools": {"allowed_paths": [], "default_timeout_ms": 60000, "max_parallel_calls": 8, "max_spawned_processes": 4, "shell_enabled": true, "shell_max_timeout_ms": 600000, "shell_timeout_ms": 30000},
  "turn": {"max_attempts": 3, "max_steps": 25}
}
```

The committed fixture is one compact canonical line, not the pretty rendering
above.

### 16.3 Layer fixtures

`global.json`:

```json
{"risk":{"allow":["rm"]},"tools":{"allowed_paths":["./shared"],"max_parallel_calls":4},"llm":{"provider":"openai","model":"gpt-5"}}
```

`project.toml`:

```toml
[llm]
protocol = "openai-responses-v1"

[tools]
allowed_paths = []

[risk]
allow = ["package_install"]
```

With deterministic source directories, the result keeps
`tools.max_parallel_calls = 4`, replaces both arrays, and therefore has no
allowed extra path and only `package_install` risk permission.

### 16.4 Provider fixtures

`openai-runnable.toml`:

```toml
[llm]
provider = "openai"
protocol = "openai-responses-v1"
model = "gpt-5"
context_window = 200000
max_output_tokens = 8192
```

`openrouter-runnable.json`:

```json
{"llm":{"provider":"openrouter","protocol":"openai-chat-v1","model":"openai/gpt-5","context_window":131072}}
```

Neither fixture contains a credential.

### 16.5 Rejection fixtures

Commit one-file fixtures for:

- `unknown-key.toml`: `[compiler] token_budget = 100000`.
- `engine.toml`: `[history] mode = "engine"`.
- `bad-clear.toml`: clear threshold equal to trigger.
- `bad-openrouter-responses.json`: unsupported provider/protocol pair.
- `secret-header.toml`: an `authorization` extra header with `[REDACTED]` value.
- `plugin-escape.toml`: built-in DB path outside the plugin root.
- `duplicate-key.json`: duplicate `llm` key.
- `json-null.json`: `{"llm":{"model":null}}`.
- `future-ui.toml`: `[ui] theme = "default"`.

## 17. Exact Test Names

The initial implementation includes tests with these names:

```text
config::tests::defaults_match_normative_toml
config::tests::defaults_effective_json_matches_rfc8785_fixture
config::tests::digest_hashes_effective_json_without_trailing_lf
config::tests::digest_excludes_credentials_and_config_source_paths
config::tests::discovery_order_is_global_json_global_toml_cwd_json_cwd_toml
config::tests::explicit_cli_path_suppresses_discovery
config::tests::explicit_env_path_suppresses_discovery
config::tests::cli_config_selector_precedes_env_selector
config::tests::missing_discovered_source_is_silent
config::tests::missing_explicit_source_is_fatal
config::tests::tables_deep_merge_scalars_replace
config::tests::arrays_replace_and_empty_array_clears
config::tests::extra_headers_map_replaces_whole_map
config::tests::unknown_key_is_fatal_in_every_layer
config::tests::json_null_is_not_a_delete_operator
config::tests::json_and_toml_duplicate_keys_are_rejected
config::tests::invalid_high_precedence_value_does_not_fall_back
config::tests::relative_path_uses_owning_source_directory
config::tests::tilde_expands_only_for_exact_prefix
config::tests::memory_db_cannot_escape_plugin_owned_root
config::tests::provider_urls_normalize_once_and_reject_credentials
config::tests::environment_override_is_strict_and_precedes_files
config::tests::cli_field_override_precedes_environment
config::tests::credential_environment_does_not_select_provider
config::tests::secret_keys_and_headers_are_rejected_without_value_logging
config::tests::history_mode_accepts_only_append
config::tests::reasoning_replay_accepts_only_active
config::tests::openrouter_responses_is_rejected_before_auth
config::tests::unknown_context_window_fails_admission_not_config_loading
config::tests::known_window_increase_requires_unsafe_flag
config::tests::fallback_fields_are_all_empty_or_complete
config::tests::compactor_fields_are_both_empty_or_complete
config::tests::incognito_and_plugin_none_select_identical_memory_boundary
config::tests::live_reload_is_rejected
config::tests::resume_reports_creation_loaded_and_applied_runtime_digests
config::tests::future_tables_and_values_are_rejected
history::tests::session_meta_config_digest_matches_snapshot
protocol::tests::session_started_config_digest_matches_meta
```

All filesystem tests use a temporary deterministic root and reject symlink
escapes on Unix and Windows. Tests that inspect error text include a secret
canary and assert it never appears.

## 18. Implementation Packet

Implement in this order with no policy choices left to the implementer:

1. Define closed `RawConfigV1` partial-source DTOs with unknown-field rejection
   and a separate complete `EffectiveConfigV1` containing every defaulted field.
2. Implement duplicate-key-rejecting JSON and strict TOML parsing with the 1 MiB
   source cap.
3. Implement source discovery and explicit-source suppression exactly as section
   3; inject home, process cwd, session cwd, and environment in tests.
4. Validate each raw layer, normalize its path values relative to its own source,
   and retain no unvalidated generic JSON/TOML map.
5. Implement one recursive merge function: objects deep-merge, scalars replace,
   arrays replace, and `extra_headers` replaces as a whole map.
6. Apply only the listed environment and CLI field overrides through the same
   typed parsers used for files.
7. Complete the section 5.1 default-overlaid value and run all cross-field and
   phase validation.
8. Resolve protocol `auto`, but retain both configured and resolved protocol in
   diagnostics; only the resolved protocol enters model selection.
9. Serialize complete canonical effective JSON with nullable
   `temperature_milli`, calculate the digest, and write private
   `config.snapshot.json` before `meta.json` and `SessionStarted` creation.
10. Thread typed values to subsystem constructors. No subsystem reparses config,
    supplies a fallback default, or receives the generic source object.
11. Implement no-memory selection before constructing any plugin or resolving
    the plugin DB path for I/O.
12. Add metadata/digest agreement checks to create/resume and emit the exact
    changed-config warning on resume.
13. Add every fixture and named test before enabling setup to write config.
14. Add setup writes as atomic private-file replace followed by a complete reload;
    never patch a parsed document in place.

The configuration module exports typed effective sections and the digest. It
does not export mutable process-global config, credential values, raw source
maps, or a generic dotted-key setter.

## 19. Common Mistakes

- Porting TypeScript aliases or warning-and-default behavior.
- Treating `history.mode = engine` as a parsed but dormant value.
- Appending `risk.allow` or `tools.allowed_paths` across layers.
- Resolving every relative path against the final cwd instead of its source.
- Expanding arbitrary environment variables or command substitutions in paths.
- Accepting JSON null as "use default" or "delete lower value".
- Letting an API-key environment variable choose the provider.
- Putting credentials in provider headers, snapshots, digests, errors, or
  fixtures.
- Guessing a context window when `llm.context_window = 0` cannot resolve.
- Allowing a known-window increase without the explicit unsafe flag and warning.
- Opening the built-in memory DB outside its fixed plugin-owned root.
- Opening a plugin in incognito mode merely to tell it that persistence is off.
- Watching config files or applying half a reload during a turn.
- Mutating runtime config through generic IPC settings.
- Recomputing old artifact/compaction decisions after config changes.
- Hashing source text instead of canonical effective JSON.
- Including source paths, credentials, or credential-store state in the digest.
- Adding a new key/default in a subsystem spec without changing this authority
  and its fixtures.

## 20. Acceptance Criteria

Configuration schema v1 is accepted only when:

1. Every accepted key, type, enum, range, default, and cross-field rule is
   represented by a typed parser and a committed fixture or named test.
2. Source order, explicit-source suppression, environment precedence, CLI
   precedence, deep-table merge, scalar replacement, array replacement, and
   map replacement match sections 3 and 4 exactly.
3. Every unknown, old, future, invalid, and secret-bearing key fails closed with
   the stable code and without logging its value.
4. Path fixtures are deterministic across Linux, macOS, and Windows, and the
   built-in memory DB cannot escape its plugin-owned root through lexical or
   symlink traversal.
5. OpenAI/OpenRouter combinations, URLs, context-window resolution, output
   bounds, fallback, and compactor pairs fail before credentials/network when
   invalid.
6. `append` and `active` are the only initial history mode and reasoning replay
   values; `engine` remains rejected until a new approved schema exists.
7. `memory.plugin = none` and incognito construct the identical no-memory core
   boundary and perform no plugin/storage/model work.
8. Canonical effective JSON is byte-identical across platforms for equivalent
   normalized inputs, and its SHA-256 agrees in snapshot, `meta.json`, and
   `SessionStarted`.
9. Resume never rewrites a durable decision when current config differs and
   reports creation, loaded, and applied runtime digests.
10. No live reload, generic dotted-key setter, arbitrary interpolation, remote
    include, or unlisted environment override exists.
11. All subsystem specs refer to these keys and do not contain a competing TOML
    schema or default.
12. The complete configuration, protocol, history, provider, tool, memory, IPC,
    and no-memory fixture suites pass with no network access.
