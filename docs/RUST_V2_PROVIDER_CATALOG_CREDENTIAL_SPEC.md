# PRAANA Rust v2 Provider Catalog and Credential Specification

**Status:** Normative implementation specification

**Provider registry schema version:** 1

**Credential store schema version:** 1

**Date:** 2026-09-01

## 1. Authority

This document owns provider registration, model/catalog discovery and trust,
capability-profile resolution, credential storage/resolution, setup/login/logout,
and filesystem permissions. Config owns non-secret provider selection and
endpoints. OpenAI owns literal request/response wire behavior. UI Contract owns
UI-facing setup/auth/catalog DTOs.

Initial providers are exactly `openai` and `openrouter`. Provider IDs are
lowercase ASCII matching `^[a-z][a-z0-9_-]{0,31}$`.

## 2. Provider Registry

```rust
pub const PROVIDER_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderDescriptorV1 {
    pub provider: ProviderId,
    pub display_name: String,
    pub protocols: Vec<ProviderProtocol>,
    pub default_base_url: String,
    pub models_endpoint: Option<String>,
    pub credential_env: String,
    pub auth_methods: Vec<AuthMethodKindDto>,
}
```

The closed rows are:

| Provider | Protocols | Base URL | Models path | Env | Auth |
|---|---|---|---|---|---|
| `openai` | Chat, Responses | `https://api.openai.com/v1` | `/models` | `OPENAI_API_KEY` | API key |
| `openrouter` | Chat only | `https://openrouter.ai/api/v1` | `/models` | `OPENROUTER_API_KEY` | API key |

OpenRouter Responses is not inferred. Custom providers, OAuth, Azure, Bedrock,
Gemini, Anthropic, and Ollama require later registry schema versions.

## 3. Bundled Model Manifest

`crates/praana-core/data/model_profiles_v1.json` is RFC 8785 JSON:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelProfileManifestV1 {
    pub schema_version: u32,
    pub generated_at_ms: i64,
    pub source_urls: Vec<String>,
    pub profiles: Vec<ModelProfileRowV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelProfileRowV1 {
    pub provider: ProviderId,
    pub protocol: ProviderProtocol,
    pub model_id: ModelId,
    pub model_revision: Option<String>,
    pub display_name: String,
    pub context_window_tokens: u64,
    pub min_output_tokens: u64,
    pub max_output_tokens: u64,
    pub reasoning_efforts: Vec<ReasoningEffort>,
    pub parallel_tools: bool,
    pub strict_json_schema: bool,
    pub tokenizer_profile_id: String,
    pub framing_profile_id: String,
    pub reasoning_accounting: ReasoningAccounting,
    pub reasoning_context: ReasoningContextCapability,
    pub self_compaction: SelfCompactionCapability,
    pub continuation_after_internal_request: bool,
    pub evidence: Vec<ProfileEvidenceV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileEvidenceV1 {
    pub url: String,
    pub accessed_on: String,
    pub field: String,
    pub value_sha256: Sha256Digest,
}
```

Rows sort by provider, protocol, model ID, revision. Duplicate keys are fatal.
Every numeric value is nonzero, min output is no greater than max, and max is
less than context window. `SelfCompactionCapability::Validated` requires a
checked-in fidelity manifest and strict JSON-schema support. A model name alone
never implies context length, tokenizer, reasoning, or compaction capability.

## 4. Live Catalog

Catalog fetch uses the provider's authenticated `GET /models`, 20-second
timeout, 16 MiB response cap, strict JSON, and no retry after authentication
failure. OpenAI model list supplies IDs/ownership only; it does not override
bundled context or capability values absent official fields. OpenRouter may
supply `context_length` and pricing metadata; live context is trusted only when
it is a positive integer at most 16,777,216 and the endpoint fingerprint is the
configured official OpenRouter endpoint. A custom base URL makes live capability
fields advisory and requires explicit Config context window.

For the official OpenRouter endpoint, `top_provider.max_completion_tokens` may
lower the resolved output maximum; null cannot raise it. `supported_parameters`
may enable `tools`, `parallel_tool_calls`, and strict structured output only when
the exact required names are present (`structured_outputs` or
`response_format` for the configured compactor). The live `reasoning` object may
limit accepted effort values. No live field grants
`SelfCompactionCapability::Validated`; that status always requires the bundled
fidelity manifest. OpenAI `/models` provides none of these capability fields.

Cache path is `<PRAANA_HOME>/cache/model-catalog-v1.json`, mode `0600`, with:

```rust
pub struct CatalogCacheV1 {
    pub schema_version: u32,
    pub provider: ProviderId,
    pub endpoint_fingerprint: Sha256Digest,
    pub fetched_at_ms: i64,
    pub expires_at_ms: i64,
    pub etag: Option<String>,
    pub body_sha256: Sha256Digest,
    pub models: Vec<LiveModelRowV1>,
}
```

TTL is six hours. On refresh failure, an unexpired cache is used with a warning;
an expired cache may provide display IDs but never new trusted capability facts.
Catalog values never alter an already-created session snapshot.

Model selection resolution is:

1. exact Config provider/protocol/model;
2. exact bundled row;
3. compatible live display row;
4. explicit Config context override under Config rules;
5. otherwise `MODEL_PROFILE_INCOMPLETE` before session creation.

The resolved `ModelCapabilityProfile` includes manifest/cache hashes, endpoint
fingerprint, and every selected field. Its RFC 8785 SHA-256 is the protocol
capability-profile hash.

The runtime type is the exact `ModelCapabilityProfile` consumed by the
Compaction specification, extended with `profile_source_sha256` and
`catalog_cache_sha256: Option<Sha256Digest>`. This document owns its resolution
and trust; Compaction owns admission math using the resolved value. Both hashes
are required keys (cache hash is JSON null without trusted live data), so two
different evidence sets cannot share a capability-profile hash.

## 5. Credential Store

`<PRAANA_HOME>/credentials.json` is the only built-in persistent credential
store. Parent is `0700`, file `0600` on Unix; Windows applies and verifies a
current-user-only ACL. Unsafe permissions block use.

```rust
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialStoreV1 {
    pub schema_version: u32,
    pub revision: u64,
    pub providers: BTreeMap<ProviderId, StoredCredentialV1>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case",
        deny_unknown_fields)]
pub enum StoredCredentialV1 {
    ApiKey { value: zeroize::Zeroizing<String>, updated_at_ms: i64 },
}
```

The file is ordinary compact JSON with one final LF, not an event or RFC 8785
hash substrate. Serialization is allowed only in the credential module;
`Debug`/`Display` redact values. API keys are 1..16,384 UTF-8 bytes, reject NUL,
CR, LF, leading/trailing whitespace, and the literal redaction marker. Empty
provider map is valid. Unknown schema/provider/type blocks mutation and login;
logout of a known row may rewrite only after complete parse succeeds.

Writes use same-directory temp mode `0600`, write, flush, fsync, rename, and
parent fsync. Revision increments once per committed mutation with checked
arithmetic. No credential appears in Config, canonical events, operation ledger
request/result JSON, logs, errors, catalog cache, or crash diagnostics.

## 6. Credential Resolution

For one selected provider:

1. an explicit UI login value being consumed by that operation;
2. persisted credential store row;
3. the provider's exact environment variable;
4. otherwise `AUTH_CREDENTIAL_MISSING`.

Environment is fallback only and is never persisted automatically. Whitespace
and bounds validation are identical. Credentials never choose provider/model.
Resolved credentials are borrowed only while building HTTP headers after
admission; the provider request object and request hash remain secret-free.

## 7. Setup, Login, and Logout

`setup.status` is generated from registry rows and Config state. Initial setup
offers provider, API-key credential, protocol-compatible model, optional official
base URL, and reasoning effort. Setup writes credential first through the
operation journal, then atomically writes the selected Config source without the
secret, then runs full Config validation. Any mixed crash state is surfaced by
operation recovery; it is not guessed.

When the selected active profile is not a fidelity-validated self-compactor but
does support strict compaction schema output, setup writes
`history.compactor_provider` and `history.compactor_model` equal to that explicit
selection. When it lacks strict output, setup requires a separate compatible
compactor selection before completion. A provider-capable setup therefore
cannot produce a configuration that fails only later at history pressure.

`auth.login` validates and atomically stores one API key, increments credential
revision, emits redacted auth state, and does not test the key by default. A
separate catalog refresh provides verification. `auth.logout` removes one row;
if it supplies the active session's only credential, new provider requests stop
and UI receives `AuthenticationRequired`. It does not mutate accepted history or
silently select an unauthenticated fallback.

## 8. Official Sources

Implementation must re-check official documentation in the same change that
updates the bundled manifest. Baseline sources accessed 2026-09-01:

- `https://developers.openai.com/api/reference/resources/models/methods/list`
- `https://developers.openai.com/api/docs/models`
- `https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties`
- `https://openrouter.ai/docs/quickstart`

Provider docs are evidence, not runtime input. A changed upstream field does not
silently reinterpret an old manifest schema.

## 9. Tests and Fixtures

Fixtures cover exact registry rows, manifest duplicate/invalid values, unknown
model, official/custom endpoint trust, live/cache/expired behavior, endpoint
fingerprints, profile hashes, permission failures, malformed credential store,
atomic crash boundaries, precedence, secret canaries, setup mixed-state recovery,
login/logout revisions, and no secret in every observable surface.

## 10. Bounded Implementation Packet

```text
crates/praana-core/src/provider/registry.rs
crates/praana-core/src/provider/catalog.rs
crates/praana-core/src/provider/profile.rs
crates/praana-core/src/credentials/mod.rs
crates/praana-core/src/credentials/store.rs
crates/praana-core/src/setup/mod.rs
crates/praana-core/data/model_profiles_v1.json
crates/praana-core/tests/provider_registry_v1.rs
crates/praana-core/tests/credentials_v1.rs
crates/praana-core/tests/setup_v1.rs
```

1. Write registry/manifest/profile fixtures and run `cargo test -p praana-core
   --test provider_registry_v1`; expected red is missing registry modules.
2. Implement bundled resolution, then fake-server live/cache behavior until
   green; no real network appears in tests.
3. Write credential permission/atomicity/precedence/canary tests. Run
   `cargo test -p praana-core --test credentials_v1`; expected red is missing
   store, then green after exact implementation.
4. Implement setup/login/logout operation-journal integration and make
   `setup_v1` green.
5. Run fmt, clippy with warnings denied, workspace tests, and offline fixture
   verification.

Non-goals: arbitrary providers, OS keychain, OAuth, server-side response state,
model-name heuristics, and automatic provider choice. Common mistakes: trusting
OpenAI list fields it does not return, treating expired cache as capability
authority, logging a response body containing a key, persisting env credentials,
or letting credentials enter request hashes.
