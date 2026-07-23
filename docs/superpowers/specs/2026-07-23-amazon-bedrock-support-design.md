# Design: Amazon Bedrock first-class support

**Date:** 2026-07-23  
**Status:** Approved  
**Branch:** `feat/ad/amazon-bedrock-support`

## Summary

Make Amazon Bedrock a first-class PRAANA provider: setup/login UX (including Bedrock API key / bearer token), config-driven region, reliable AWS credential detection, and a **live** chat-model catalog from AWS (`ListFoundationModels` + `ListInferenceProfiles`) that prefers inference profiles. Model invocation continues to use pi-ai’s existing `bedrock-converse-stream` path.

## Background

PRAANA already registers `amazon-bedrock` in `PROVIDER_REGISTRY` with `api: "bedrock-converse-stream"` and `envKey: null`. Detection, a default model id, and pi-ai’s static catalog exist, but:

- Bedrock is excluded from interactive setup (`SETUP_UNSUPPORTED_PROVIDERS`).
- Availability checks miss several AWS auth sources (bearer token, web identity, container credentials).
- There is no `llm.region` and no live account/region catalog.
- Many Claude models require inference profile IDs (`us.…`) for on-demand invoke; the static catalog alone does not reflect what is enabled in the user’s account.

## Goals

1. **UX** — Bedrock appears in `/setup` and login; users can paste a Bedrock API key when no ambient AWS credentials exist.
2. **Runtime** — Widen credential detection; resolve region from config/env; clear missing-creds messaging.
3. **Catalog** — Live list of chat-capable models for the configured region/account; prefer inference profiles over base foundation model IDs.
4. **Compatibility** — Keep pi-ai as the invoke/stream implementation; merge live catalog with pi-ai static models like other live-catalog providers.

## Non-goals

- Replacing pi-ai’s ConverseStream implementation with a PRAANA-owned Bedrock client.
- Region prompting in setup (region is config/env only).
- First-class UX for provisioned throughput, Marketplace ARNs, embeddings, or image-only models (typed IDs may still work at invoke time).
- Custom VPC/proxy endpoint UX beyond what pi-ai already supports.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Scope | First-class UX + runtime reliability |
| Catalog source | Live AWS control-plane APIs |
| Region | Config/env only: `llm.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1` |
| Catalog filter | Chat-capable TEXT in/out only |
| Profile vs base ID | Prefer inference profiles; keep base ID only when no profile exists |
| No ambient creds | Prompt for Bedrock API key (bearer token); store in credential store |
| Approach | Thin Bedrock helper + existing provider-catalog cache; pi-ai for invoke |

## Architecture

```
llm.region / AWS_REGION / AWS_DEFAULT_REGION
            │
            ▼
   resolveBedrockRegion()
            │
            ├──► isProviderAvailable("amazon-bedrock")
            │       ambient AWS env OR credential-store bearer token
            │
            ├──► fetchBedrockLiveCatalog(region)
            │         ListInferenceProfiles
            │         ListFoundationModels(byOutputModality=TEXT)
            │         filter chat-capable; prefer profiles
            │         ▼
            │    provider-catalog.ts (6h disk TTL, key "amazon-bedrock")
            │         │
            │         ▼
            │    /model · setup · listModelsForProvider
            │
            └──► buildModel() → model.__piOptions
                      region: resolveBedrockRegion(config)
                      bearerToken: store/env when present
                      │
invoke ─────────────► pi-ai bedrock-converse-stream
```

`llm.region` MUST affect both catalog listing and invoke. Pass `region` and `bearerToken` via `RuntimeModel.__piOptions` (consumed by `turn.ts` when streaming). Do **not** put the Bedrock API key in `apiKey` — pi-ai’s Converse path uses `bearerToken` / `AWS_BEARER_TOKEN_BEDROCK`, not `apiKey`.

### New / touched modules

| Area | Change |
|---|---|
| `src/bedrock/region.ts` | `resolveBedrockRegion(config?)` |
| `src/bedrock/credentials.ts` | Ambient AWS + store bearer detection helpers; missing-key message |
| `src/bedrock/catalog.ts` | Control-plane list + filter + profile preference |
| `src/provider-catalog.ts` | Bedrock branch in `fetchProviderCatalogFresh`; mark live-catalog support |
| `src/provider-registry.ts` | Remove Bedrock from `SETUP_UNSUPPORTED_PROVIDERS`; add to live catalog ids |
| `src/llm.ts` | Widen `isProviderAvailable`; set `__piOptions.region` + `__piOptions.bearerToken` for Bedrock |
| `src/types.ts` + `src/config.ts` | `LlmConfig.region?: string` validation |
| `src/setup/*`, login wizard | Bedrock branch: ambient creds **or** prompt-for-bearer (not generic `finishKeyless`) |
| Docs + `praana.config.example.toml` | Auth, region, live catalog behavior |
| Dependency | `@aws-sdk/client-bedrock` (control plane) |

Runtime invoke continues to use pi-ai’s transitive `@aws-sdk/client-bedrock-runtime`.

## Region

```ts
resolveBedrockRegion(config?: { region?: string }): string
// precedence: config.region → AWS_REGION → AWS_DEFAULT_REGION → "us-east-1"
```

- Config field: `llm.region` (optional string). Ignored by non-Bedrock providers.
- No setup prompt for region.
- Callers: live catalog fetch **and** `buildModel` → `__piOptions.region` so invoke uses the same value pi-ai’s `BedrockOptions.region` expects.

## Credentials & availability

Bedrock is **available** when any of the following is true:

1. Credential store has a key for `amazon-bedrock` (Bedrock API key / bearer token).
2. `AWS_BEARER_TOKEN_BEDROCK` is set.
3. `AWS_ACCESS_KEY_ID` is set.
4. `AWS_PROFILE` is set.
5. `AWS_SESSION_TOKEN` is set.
6. `AWS_WEB_IDENTITY_TOKEN_FILE` is set.
7. `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set.

Notes:

- Matching pi-ai’s ambient sources as closely as practical; do not invent fake availability for bare `envKey: null`.
- Users with only `~/.aws/credentials` (default profile, no env) may still set `provider = "amazon-bedrock"` explicitly; the SDK default chain can succeed at invoke even if detection is false. Document this.
- Missing-key / setup copy must mention: IAM access keys, `AWS_PROFILE`, container/web-identity roles, **or** a Bedrock API key via setup/login.

### Bearer token at invoke / catalog

- Resolve bearer as: credential store key for `amazon-bedrock` → else `AWS_BEARER_TOKEN_BEDROCK`.
- On `buildModel` for provider `amazon-bedrock`, set `__piOptions.bearerToken` to that value when present (not `apiKey`).
- Catalog `BedrockClient` construction must use the same bearer when present so list calls work for API-key-only users.
- Never log bearer tokens or secret access keys.

## Live catalog

### Fetch

1. Resolve region.
2. Construct `BedrockClient` with the default credential provider chain (and bearer token when configured).
3. `ListInferenceProfiles` + `ListFoundationModels` with `byOutputModality: "TEXT"`.
4. Filter to chat-capable models:
   - Foundation models: `outputModalities` includes `TEXT` **and** `inputModalities` includes `TEXT`.
   - Streaming: **hard-exclude** when `responseStreamingSupported === false`. When the field is absent (common on inference profiles), keep the entry if it otherwise passes the TEXT chat filter (PRAANA only invokes via ConverseStream).
5. **Prefer inference profiles** (deterministic match rule):
   - From each `InferenceProfileSummary` with `status === "ACTIVE"` (both `SYSTEM_DEFINED` and `APPLICATION`), take `inferenceProfileId` and each `models[].modelArn`.
   - Extract the foundation model id as the ARN suffix after `foundation-model/` (e.g. `arn:aws:bedrock:…::foundation-model/anthropic.claude-…` → `anthropic.claude-…`). Skip ARNs that do not contain `foundation-model/`.
   - A profile is **qualifying** only if at least one linked foundation model id is in the TEXT chat-capable set from step 4 (profiles have no modality fields of their own).
   - Build a set of covered foundation model ids from qualifying profiles.
   - Emit each qualifying profile’s `inferenceProfileId` into the catalog.
   - Emit a foundation model `modelId` only if it passes the chat filter **and** is not in the covered set.
   - If multiple qualifying profiles cover the same foundation model, keep all profile ids (do not collapse geographic variants); only suppress the base id.
6. Context window: copy from pi-ai static metadata when the catalog id equals a pi-ai id, or when the foundation model id extracted from a profile matches a pi-ai id; otherwise `null`.
7. Persist under provider key `amazon-bedrock` in the existing provider-catalog disk cache (same 6h TTL, abort/timeout behavior).

### Integration

- `providerSupportsLiveCatalog("amazon-bedrock")` → true.
- `fetchProviderCatalogFresh` branches for Bedrock instead of HTTP `GET …/models`.
- `listModelsForProvider` merge behavior unchanged: pi-ai ∪ live; live failures soft-fail when static models exist.

### Soft-fail

- AccessDenied, timeout, wrong region, empty filtered set → keep pi-ai static Bedrock models; log/toast one line: live catalog unavailable with reason.

## Setup & login

1. Remove `amazon-bedrock` from `SETUP_UNSUPPORTED_PROVIDERS`.
2. `providerRequiresApiKey("amazon-bedrock")` remains false (`envKey: null`). Do **not** use the generic keyless `finishKeyless` path blindly.
3. Selecting Bedrock (setup wizard, readline setup, login wizard) uses an explicit branch:
   - If `isProviderAvailable("amazon-bedrock")` (ambient AWS **or** stored/env bearer) → skip key prompt; write `provider` (+ default/first catalog model).
   - Else → prompt for **Bedrock API key** (bearer token); save via credential store (`setApiKey("amazon-bedrock", …)`); then write config.
4. Model list in setup: prefer live catalog; fall back to pi-ai static on failure.
5. Region remains documentation + config/env (not asked in the wizard).

## Error handling

| Situation | Behavior |
|---|---|
| Live catalog fails | Soft-fail to pi-ai static models + short status message |
| Empty after chat filter | Treat as catalog failure (soft-fail) |
| Invoke auth/throttle errors | Unchanged (pi-ai); improve only pre-flight missing-creds text |
| Secrets in logs | Forbidden |

## Testing

- Unit: region precedence; availability matrix (env + store); chat filter + profile preference with fixtures (no live AWS).
- Catalog: mocked Bedrock client → cache shape, TTL reuse, soft-fail path.
- Setup: Bedrock in picker; no-creds → key prompt; with creds → skip prompt and persist provider.
- Update existing `amazon-bedrock` availability tests for widened checks and store bearer.

## Documentation

Update before implementation commit:

- `AGENTS.md` — Bedrock among providers; `llm.region`; auth options including API key.
- `docs/ARCHITECTURE.md` — live catalog note for Bedrock (control plane, not `/models`).
- `praana.config.example.toml` — commented `region` + Bedrock auth notes.
- Internal docs under `~/win_documents/Github/praana-internal` (mirror the user-facing notes).

## Success criteria

- User can select Bedrock in `/setup`, paste a Bedrock API key when needed, and complete setup without ambient IAM env vars.
- With valid AWS auth, `/model` lists chat-capable models for the account/region, preferring inference profile ids.
- `llm.region` and standard AWS region env vars control catalog + invoke region resolution.
- Invoke still streams via pi-ai; no regression for other providers.
- `bun typecheck` and `bun test` pass.
`)