//! Setup, login, and logout services for provider packet P2A.
//!
//! This module owns provider-neutral setup orchestration. Secrets are consumed
//! from `SetupValueDto::Secret` only long enough to update the credential store;
//! config and result DTOs contain provider/model choices, never key material.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::config::{build_defaults, load_effective_config, ConfigCliOverrides, ConfigLoaderEnv};
use crate::credentials::{
    credentials_path, load_store, remove_credential, save_store, upsert_credential,
    validate_credential_value, CredentialStoreError, CredentialStoreV1,
};
use crate::history::operation_ledger::{
    complete_operation, open_host_ledger, reserve_operation_sync, HistoryService,
};
use crate::provider::{bundled_manifest, endpoint_trust, resolve_profile, ProviderProtocol};
use crate::ui_contract::catalog::{
    ActiveModelDto, ProviderProtocol as UiProviderProtocol, ReasoningEffort as UiReasoningEffort,
};
use crate::ui_contract::command::{
    AuthLoginCommand, AuthLogoutCommand, CoreCommand, SetupApplyCommand,
};
use crate::ui_contract::ids::OperationId;
use crate::ui_contract::json_data::{ModelId, ProviderId};
use crate::ui_contract::operation::{OperationReservation, StoredTerminalResult};
use crate::ui_contract::result::CoreCommandSuccess;
use crate::ui_contract::setup::{
    validate_setup_values, AuthLoginResultDto, AuthLogoutResultDto, AuthMethodDto,
    AuthMethodKindDto as UiAuthMethodKindDto, AuthState, ProviderAuthStatusDto,
    SetupApplyResultDto, SetupChoiceDto, SetupFieldDto, SetupFieldId, SetupFieldKind,
    SetupProviderDto, SetupStatusDto, SetupValueDto,
};

const FIELD_API_KEY: &str = "api_key";
const FIELD_BASE_URL: &str = "base_url";
const FIELD_PROTOCOL: &str = "protocol";
const FIELD_REASONING_EFFORT: &str = "reasoning_effort";
const FIELD_COMPACTOR_PROVIDER: &str = "compactor_provider";
const FIELD_COMPACTOR_MODEL: &str = "compactor_model";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SetupError {
    Credential(CredentialStoreError),
    ProviderUnknown(String),
    ModelUnknown(String),
    InvalidInput(String),
    RevisionConflict { expected: u64, actual: u64 },
    Config(String),
    Io(String),
}

impl fmt::Display for SetupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Credential(error) => error.fmt(formatter),
            Self::ProviderUnknown(provider) => write!(formatter, "PROVIDER_UNKNOWN: {provider}"),
            Self::ModelUnknown(model) => write!(formatter, "MODEL_PROFILE_INCOMPLETE: {model}"),
            Self::InvalidInput(detail) => write!(formatter, "SETUP_INVALID: {detail}"),
            Self::RevisionConflict { expected, actual } => {
                write!(
                    formatter,
                    "SETUP_REVISION_CONFLICT: expected {expected}, actual {actual}"
                )
            }
            Self::Config(detail) => write!(formatter, "SETUP_CONFIG_INVALID: {detail}"),
            Self::Io(detail) => write!(formatter, "SETUP_IO: {detail}"),
        }
    }
}

impl std::error::Error for SetupError {}

impl From<CredentialStoreError> for SetupError {
    fn from(error: CredentialStoreError) -> Self {
        Self::Credential(error)
    }
}

fn core_error_text(error: &crate::ui_contract::result::CoreErrorDto) -> String {
    serde_json::to_string(error).unwrap_or_else(|_| "core operation failed".to_owned())
}

fn provider_protocol_ui(protocol: &ProviderProtocol) -> UiProviderProtocol {
    match protocol {
        ProviderProtocol::Chat => UiProviderProtocol::OpenAiChatCompletions,
        ProviderProtocol::Responses => UiProviderProtocol::OpenAiResponses,
    }
}

fn reasoning_ui(value: &str) -> Option<UiReasoningEffort> {
    match value {
        "off" => Some(UiReasoningEffort::Off),
        "minimal" => Some(UiReasoningEffort::Minimal),
        "low" => Some(UiReasoningEffort::Low),
        "medium" => Some(UiReasoningEffort::Medium),
        "high" => Some(UiReasoningEffort::High),
        "xhigh" => Some(UiReasoningEffort::Xhigh),
        _ => None,
    }
}

fn reasoning_protocol(value: &str) -> Option<crate::protocol::models::ReasoningEffort> {
    match value {
        "off" => Some(crate::protocol::models::ReasoningEffort::Off),
        "minimal" => Some(crate::protocol::models::ReasoningEffort::Minimal),
        "low" => Some(crate::protocol::models::ReasoningEffort::Low),
        "medium" => Some(crate::protocol::models::ReasoningEffort::Medium),
        "high" => Some(crate::protocol::models::ReasoningEffort::High),
        "xhigh" => Some(crate::protocol::models::ReasoningEffort::Xhigh),
        _ => None,
    }
}

fn default_protocol(provider: &str) -> ProviderProtocol {
    if provider == "openai" {
        ProviderProtocol::Responses
    } else {
        ProviderProtocol::Chat
    }
}

fn protocol_from_config(provider: &str, protocol: &str) -> Result<ProviderProtocol, SetupError> {
    match protocol {
        "auto" => Ok(default_protocol(provider)),
        "openai-chat-v1" => Ok(ProviderProtocol::Chat),
        "openai-responses-v1" => Ok(ProviderProtocol::Responses),
        other => Err(SetupError::InvalidInput(format!(
            "unknown protocol {other}"
        ))),
    }
}

fn field(id: &str, label: &str, help: &str, kind: SetupFieldKind, required: bool) -> SetupFieldDto {
    let secret = matches!(&kind, SetupFieldKind::Secret);
    SetupFieldDto {
        id: SetupFieldId(id.to_owned()),
        label: label.to_owned(),
        help: help.to_owned(),
        kind,
        required,
        secret,
        choices: Vec::new(),
        default_value: None,
    }
}

fn provider_setup(provider: &crate::provider::ProviderDescriptorV1) -> SetupProviderDto {
    let mut api_key = field(
        FIELD_API_KEY,
        "API key",
        "Stored in the private credential store; never written to config.",
        SetupFieldKind::Secret,
        true,
    );
    api_key.default_value = None;
    let mut base_url = field(
        FIELD_BASE_URL,
        "Base URL",
        "The provider base URL; the adapter appends its exact endpoint.",
        SetupFieldKind::Text,
        true,
    );
    base_url.default_value = Some(provider.default_base_url.clone());

    let mut protocol = field(
        FIELD_PROTOCOL,
        "Protocol",
        "The wire protocol used for the selected model.",
        SetupFieldKind::Choice,
        true,
    );
    protocol.choices = provider
        .protocols
        .iter()
        .map(|value| SetupChoiceDto {
            value: value.config_name().to_owned(),
            label: value.ui_name().to_owned(),
        })
        .collect();
    protocol.default_value = provider
        .protocols
        .first()
        .map(|value| value.config_name().to_owned());

    let mut reasoning = field(
        FIELD_REASONING_EFFORT,
        "Reasoning effort",
        "The requested provider reasoning level.",
        SetupFieldKind::Choice,
        true,
    );
    reasoning.choices = ["off", "minimal", "low", "medium", "high", "xhigh"]
        .iter()
        .filter_map(|value| {
            reasoning_ui(value).map(|_| SetupChoiceDto {
                value: (*value).to_owned(),
                label: (*value).to_owned(),
            })
        })
        .collect();
    reasoning.default_value = Some("medium".to_owned());

    let compactor_provider = field(
        FIELD_COMPACTOR_PROVIDER,
        "Compactor provider",
        "Optional separate provider for history compaction when the active model cannot emit strict compaction JSON.",
        SetupFieldKind::Text,
        false,
    );
    let compactor_model = field(
        FIELD_COMPACTOR_MODEL,
        "Compactor model",
        "Optional separate strict-schema model for history compaction.",
        SetupFieldKind::Text,
        false,
    );

    SetupProviderDto {
        provider: provider.provider.clone(),
        display_name: provider.display_name.clone(),
        fields: vec![
            api_key,
            base_url,
            protocol,
            reasoning,
            compactor_provider,
            compactor_model,
        ],
        auth_methods: vec![UiAuthMethodKindDto::ApiKey],
        supported_protocols: provider
            .protocols
            .iter()
            .map(provider_protocol_ui)
            .collect(),
    }
}

pub fn build_setup_status(
    config: &crate::config::EffectiveConfigV1,
    credentials: &CredentialStoreV1,
    revision: u64,
) -> Result<SetupStatusDto, SetupError> {
    credentials.validate()?;
    let providers = crate::provider::provider_registry()
        .iter()
        .map(provider_setup)
        .collect::<Vec<_>>();
    let configured_providers = credentials.providers.keys().cloned().collect::<Vec<_>>();
    let authentication = crate::provider::provider_registry()
        .iter()
        .map(|provider| ProviderAuthStatusDto {
            provider: provider.provider.clone(),
            state: if credentials
                .credential_value(provider.provider.as_str())
                .is_some()
            {
                AuthState::Authenticated
            } else {
                AuthState::Unauthenticated
            },
            methods: vec![UiAuthMethodKindDto::ApiKey],
        })
        .collect();
    let required = config.llm.provider.trim().is_empty() || config.llm.model.trim().is_empty();
    let mut missing_requirements = Vec::new();
    if config.llm.provider.trim().is_empty() {
        missing_requirements.push("llm.provider".to_owned());
    }
    if config.llm.model.trim().is_empty() {
        missing_requirements.push("llm.model".to_owned());
    }
    Ok(SetupStatusDto {
        revision,
        required,
        providers,
        configured_providers,
        authentication,
        active_auth_flows: Vec::new(),
        missing_requirements,
        pending_consents: Vec::new(),
    })
}

#[derive(Clone, Debug)]
pub struct SetupService {
    praana_home: PathBuf,
    config_path: PathBuf,
}

impl SetupService {
    pub fn new(praana_home: PathBuf) -> Self {
        let config_path = praana_home.join("praana.config.json");
        Self {
            praana_home,
            config_path,
        }
    }

    /// Use an explicit Config-owned source rather than silently changing the
    /// global source selected by the loader.
    pub fn with_config_path(praana_home: PathBuf, config_path: PathBuf) -> Self {
        Self {
            praana_home,
            config_path,
        }
    }

    pub fn credential_path(&self) -> PathBuf {
        credentials_path(&self.praana_home)
    }

    fn host_operation_context(
        &self,
        now_ms: i64,
    ) -> Result<
        (
            Arc<crate::history::operation_ledger::OperationLedger>,
            HistoryService,
        ),
        SetupError,
    > {
        let ledger = Arc::new(
            open_host_ledger(&self.praana_home.join("ui-operations.db"))
                .map_err(|error| SetupError::Io(error.to_string()))?,
        );
        let history = HistoryService {
            host_ledger: Some(ledger.clone()),
            now_ms: Arc::new(move || now_ms),
            ..HistoryService::default()
        };
        Ok((ledger, history))
    }

    pub fn status(
        &self,
        config: &crate::config::EffectiveConfigV1,
        revision: u64,
    ) -> Result<SetupStatusDto, SetupError> {
        let credentials = load_store(&self.credential_path())?;
        build_setup_status(config, &credentials, revision)
    }

    pub fn login(
        &self,
        provider: &str,
        credential: String,
        now_ms: i64,
    ) -> Result<AuthLoginResultDto, SetupError> {
        let operation_id = OperationId(ulid::Ulid::generate());
        self.login_operation(operation_id, provider, credential, now_ms)
    }

    pub fn login_operation(
        &self,
        operation_id: OperationId,
        provider: &str,
        credential: String,
        now_ms: i64,
    ) -> Result<AuthLoginResultDto, SetupError> {
        let provider_id = ProviderId::from_canonical_str(provider)
            .map_err(|_| SetupError::ProviderUnknown(provider.to_owned()))?;
        validate_credential_value(&credential)?;
        let command = CoreCommand::AuthLogin(AuthLoginCommand {
            operation_id,
            provider: provider_id.clone(),
            method: AuthMethodDto::ApiKey {
                credential: credential.clone().into(),
            },
        });
        let (ledger, history) = self.host_operation_context(now_ms)?;
        let reservation = reserve_operation_sync(&ledger, &command, &history)
            .map_err(|error| SetupError::Io(core_error_text(&error)))?;
        if let OperationReservation::ReplayStored(StoredTerminalResult::Success(
            CoreCommandSuccess::AuthLogin(result),
        )) = &reservation
        {
            return Ok(result.clone());
        }
        let record = match reservation {
            OperationReservation::Reserved(record) => record,
            OperationReservation::ReplayStored(_) => {
                return Err(SetupError::Io(
                    "stored auth login result has wrong type".to_owned(),
                ))
            }
        };
        let mut store = load_store(&self.credential_path())?;
        upsert_credential(&mut store, provider, credential, now_ms)?;
        save_store(&self.credential_path(), &store)?;
        let result = AuthLoginResultDto {
            provider: provider_id,
            state: AuthState::Authenticated,
            flow: None,
        };
        complete_operation(
            &ledger,
            &record,
            Ok(CoreCommandSuccess::AuthLogin(result.clone())),
        )
        .map_err(|error| SetupError::Io(core_error_text(&error)))?;
        Ok(result)
    }

    pub fn login_method(
        &self,
        provider: &str,
        method: AuthMethodDto,
        now_ms: i64,
    ) -> Result<AuthLoginResultDto, SetupError> {
        match method {
            AuthMethodDto::ApiKey { credential } => {
                self.login(provider, credential.expose().to_owned(), now_ms)
            }
            AuthMethodDto::DeviceCode | AuthMethodDto::Browser => Err(SetupError::InvalidInput(
                "only API key authentication is supported in registry schema 1".to_owned(),
            )),
        }
    }

    pub fn logout(&self, provider: &str) -> Result<AuthLogoutResultDto, SetupError> {
        let operation_id = OperationId(ulid::Ulid::generate());
        self.logout_operation(
            operation_id,
            provider,
            crate::history::operation_ledger::system_now_ms(),
        )
    }

    pub fn logout_operation(
        &self,
        operation_id: OperationId,
        provider: &str,
        now_ms: i64,
    ) -> Result<AuthLogoutResultDto, SetupError> {
        let provider_id = ProviderId::from_canonical_str(provider)
            .map_err(|_| SetupError::ProviderUnknown(provider.to_owned()))?;
        let command = CoreCommand::AuthLogout(AuthLogoutCommand {
            operation_id,
            provider: provider_id.clone(),
        });
        let (ledger, history) = self.host_operation_context(now_ms)?;
        let reservation = reserve_operation_sync(&ledger, &command, &history)
            .map_err(|error| SetupError::Io(core_error_text(&error)))?;
        if let OperationReservation::ReplayStored(StoredTerminalResult::Success(
            CoreCommandSuccess::AuthLogout(result),
        )) = &reservation
        {
            return Ok(result.clone());
        }
        let record = match reservation {
            OperationReservation::Reserved(record) => record,
            OperationReservation::ReplayStored(_) => {
                return Err(SetupError::Io(
                    "stored auth logout result has wrong type".to_owned(),
                ))
            }
        };
        let mut store = load_store(&self.credential_path())?;
        let had_only_credential =
            store.providers.len() == 1 && store.credential_value(provider).is_some();
        remove_credential(&mut store, provider)?;
        save_store(&self.credential_path(), &store)?;
        let result = AuthLogoutResultDto {
            provider: provider_id,
            state: AuthState::Unauthenticated,
            fallback_model: None,
            authentication_required: had_only_credential && store.providers.is_empty(),
        };
        complete_operation(
            &ledger,
            &record,
            Ok(CoreCommandSuccess::AuthLogout(result.clone())),
        )
        .map_err(|error| SetupError::Io(core_error_text(&error)))?;
        Ok(result)
    }

    pub fn apply(
        &self,
        expected_revision: u64,
        provider: ProviderId,
        model_id: ModelId,
        values: BTreeMap<SetupFieldId, SetupValueDto>,
        now_ms: i64,
    ) -> Result<SetupApplyResultDto, SetupError> {
        let operation_id = OperationId(ulid::Ulid::generate());
        self.apply_operation(
            operation_id,
            expected_revision,
            provider,
            model_id,
            values,
            now_ms,
        )
    }

    pub fn apply_operation(
        &self,
        operation_id: OperationId,
        expected_revision: u64,
        provider: ProviderId,
        model_id: ModelId,
        values: BTreeMap<SetupFieldId, SetupValueDto>,
        now_ms: i64,
    ) -> Result<SetupApplyResultDto, SetupError> {
        let provider_name = provider.as_str();
        let descriptor = crate::provider::provider_descriptor(provider_name)
            .ok_or_else(|| SetupError::ProviderUnknown(provider_name.to_owned()))?;
        let fields = provider_setup(descriptor).fields;
        validate_setup_values(&fields, &values).map_err(SetupError::InvalidInput)?;
        let mut store = load_store(&self.credential_path())?;
        if store.revision != expected_revision {
            return Err(SetupError::RevisionConflict {
                expected: expected_revision,
                actual: store.revision,
            });
        }
        let protocol_name = choice_value(&values, FIELD_PROTOCOL)?;
        let protocol = protocol_from_config(provider_name, protocol_name)?;
        let base_url = choice_value(&values, FIELD_BASE_URL)?;
        endpoint_trust(provider_name, base_url)
            .map_err(|error| SetupError::Config(error.to_string()))?;
        let profile = resolve_profile(provider_name, &protocol, model_id.as_str(), None)
            .map_err(|error| SetupError::ModelUnknown(error.to_string()))?;
        let manifest = bundled_manifest().map_err(|error| SetupError::Config(error.to_string()))?;
        let profile_row = manifest
            .profiles
            .iter()
            .find(|row| {
                row.provider.as_str() == provider_name
                    && row.model_id.as_str() == model_id.as_str()
                    && row.protocol == protocol
            })
            .ok_or_else(|| SetupError::ModelUnknown(model_id.to_string()))?;
        let (compactor_provider, compactor_model) =
            resolve_compactor_selection(&values, provider_name, &protocol, profile_row, &manifest)?;
        let reasoning = choice_value(&values, FIELD_REASONING_EFFORT)?;
        let reasoning_value = reasoning_protocol(reasoning)
            .ok_or_else(|| SetupError::InvalidInput("unsupported reasoning effort".to_owned()))?;
        if !profile_row.reasoning_efforts.contains(&reasoning_value) {
            return Err(SetupError::InvalidInput(
                "reasoning effort is not supported by the selected model".to_owned(),
            ));
        }
        let config_bytes = setup_config_bytes(
            &self.praana_home,
            &self.config_path,
            provider_name,
            protocol.config_name(),
            model_id.as_str(),
            reasoning,
            base_url,
            &compactor_provider,
            &compactor_model,
        )?;
        let operation_values = clone_setup_values_for_operation(&values);
        let command = CoreCommand::SetupApply(SetupApplyCommand {
            operation_id,
            expected_revision,
            provider: provider.clone(),
            model_id: model_id.clone(),
            values: operation_values,
        });
        let (ledger, history) = self.host_operation_context(now_ms)?;
        let reservation = reserve_operation_sync(&ledger, &command, &history)
            .map_err(|error| SetupError::Io(core_error_text(&error)))?;
        if let OperationReservation::ReplayStored(StoredTerminalResult::Success(
            CoreCommandSuccess::SetupApplied(result),
        )) = &reservation
        {
            return Ok(result.clone());
        }
        let record = match reservation {
            OperationReservation::Reserved(record) => record,
            OperationReservation::ReplayStored(_) => {
                return Err(SetupError::Io(
                    "stored setup result has wrong type".to_owned(),
                ))
            }
        };
        let secret = match values.get(&SetupFieldId(FIELD_API_KEY.to_owned())) {
            Some(SetupValueDto::Secret(value)) => Some(value.expose().to_owned()),
            _ => None,
        };
        if let Some(secret) = secret {
            upsert_credential(&mut store, provider_name, secret, now_ms)?;
        }
        if store.credential_value(provider_name).is_none() {
            return Err(SetupError::Credential(
                CredentialStoreError::CredentialMissing,
            ));
        }
        save_store(&self.credential_path(), &store)?;

        write_private_atomic(&self.config_path, &config_bytes)?;
        validate_written_config(&self.praana_home, &self.config_path)?;
        let active_model = ActiveModelDto {
            provider,
            model_id,
            display_name: bundled_display_name(&profile, &config_bytes),
            protocol: provider_protocol_ui(&protocol),
            reasoning_effort: reasoning_ui(reasoning).unwrap_or(UiReasoningEffort::Medium),
            context_window_tokens: profile.context_window_tokens,
            boundary_canonical_sequence: None,
        };
        let result = SetupApplyResultDto {
            revision: store.revision,
            configured_provider: active_model.provider.clone(),
            active_model,
            restart_required: true,
        };
        complete_operation(
            &ledger,
            &record,
            Ok(CoreCommandSuccess::SetupApplied(result.clone())),
        )
        .map_err(|error| SetupError::Io(core_error_text(&error)))?;
        Ok(result)
    }
}

fn choice_value<'a>(
    values: &'a BTreeMap<SetupFieldId, SetupValueDto>,
    field_name: &str,
) -> Result<&'a str, SetupError> {
    match values.get(&SetupFieldId(field_name.to_owned())) {
        Some(SetupValueDto::Text(value)) | Some(SetupValueDto::Choice(value)) => Ok(value),
        Some(SetupValueDto::Secret(_)) | Some(SetupValueDto::Boolean(_)) => Err(
            SetupError::InvalidInput(format!("field {field_name} must be text or choice")),
        ),
        None => Err(SetupError::InvalidInput(format!(
            "missing field {field_name}"
        ))),
    }
}

fn clone_setup_values_for_operation(
    values: &BTreeMap<SetupFieldId, SetupValueDto>,
) -> BTreeMap<SetupFieldId, SetupValueDto> {
    values
        .iter()
        .map(|(field, value)| {
            let copied = match value {
                SetupValueDto::Text(value) => SetupValueDto::Text(value.clone()),
                SetupValueDto::Choice(value) => SetupValueDto::Choice(value.clone()),
                SetupValueDto::Boolean(value) => SetupValueDto::Boolean(*value),
                SetupValueDto::Secret(value) => {
                    SetupValueDto::Secret(value.expose().to_owned().into())
                }
            };
            (field.clone(), copied)
        })
        .collect()
}

fn optional_text_value(
    values: &BTreeMap<SetupFieldId, SetupValueDto>,
    field_name: &str,
) -> Result<Option<String>, SetupError> {
    match values.get(&SetupFieldId(field_name.to_owned())) {
        None => Ok(None),
        Some(SetupValueDto::Text(value)) | Some(SetupValueDto::Choice(value)) => {
            if value.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(value.clone()))
            }
        }
        Some(SetupValueDto::Secret(_) | SetupValueDto::Boolean(_)) => Err(
            SetupError::InvalidInput(format!("field {field_name} must be text or choice")),
        ),
    }
}

fn resolve_compactor_selection(
    values: &BTreeMap<SetupFieldId, SetupValueDto>,
    primary_provider: &str,
    primary_protocol: &ProviderProtocol,
    primary_row: &crate::provider::ModelProfileRowV1,
    manifest: &crate::provider::ModelProfileManifestV1,
) -> Result<(String, String), SetupError> {
    let compactor_provider = optional_text_value(values, FIELD_COMPACTOR_PROVIDER)?;
    let compactor_model = optional_text_value(values, FIELD_COMPACTOR_MODEL)?;
    if compactor_provider.is_some() != compactor_model.is_some() {
        return Err(SetupError::InvalidInput(
            "compactor_provider and compactor_model must be supplied together".to_owned(),
        ));
    }
    let Some(compactor_provider) = compactor_provider else {
        if !primary_row.strict_json_schema {
            return Err(SetupError::Config(
                "a separate strict compactor selection is required".to_owned(),
            ));
        }
        return Ok((
            primary_provider.to_owned(),
            primary_row.model_id.to_string(),
        ));
    };
    let compactor_model = compactor_model.expect("compactor model checked with provider");
    if crate::provider::provider_descriptor(&compactor_provider).is_none() {
        return Err(SetupError::ProviderUnknown(compactor_provider));
    }
    let compactor_protocol = if compactor_provider == "openai" {
        ProviderProtocol::Responses
    } else {
        ProviderProtocol::Chat
    };
    let compactor_row = manifest
        .profiles
        .iter()
        .find(|row| {
            row.provider.as_str() == compactor_provider
                && row.model_id.as_str() == compactor_model
                && row.protocol == compactor_protocol
        })
        .ok_or_else(|| SetupError::ModelUnknown(compactor_model.clone()))?;
    if !compactor_row.strict_json_schema {
        return Err(SetupError::Config(
            "selected compactor does not support strict compaction output".to_owned(),
        ));
    }
    if primary_row.strict_json_schema
        && compactor_provider == primary_provider
        && compactor_protocol == *primary_protocol
        && compactor_model == primary_row.model_id.as_str()
    {
        return Ok((compactor_provider, compactor_model));
    }
    Ok((compactor_provider, compactor_model))
}

fn validate_written_config(praana_home: &Path, config_path: &Path) -> Result<(), SetupError> {
    let bytes = fs::read(config_path).map_err(|error| SetupError::Io(error.to_string()))?;
    let source = bytes.strip_suffix(b"\\n").unwrap_or(&bytes);
    let raw = crate::config::RawConfigV1::parse_json(source)
        .map_err(|error| SetupError::Config(error.to_string()))?;
    let mut effective = build_defaults(praana_home);
    crate::config::merge::merge_raw_into_effective(&mut effective, raw);
    crate::config::validate::validate_effective_config(&mut effective, praana_home)
        .map_err(|error| SetupError::Config(error.to_string()))?;
    Ok(())
}

fn bundled_display_name(
    profile: &crate::provider::ModelCapabilityProfile,
    _config_bytes: &[u8],
) -> String {
    bundled_manifest()
        .ok()
        .and_then(|manifest| {
            manifest
                .profiles
                .into_iter()
                .find(|row| row.model_id.as_str() == profile.model_pattern)
                .map(|row| row.display_name)
        })
        .unwrap_or_else(|| profile.model_pattern.clone())
}

#[allow(clippy::too_many_arguments)]
fn setup_config_bytes(
    praana_home: &Path,
    config_path: &Path,
    provider: &str,
    protocol: &str,
    model: &str,
    reasoning_effort: &str,
    base_url: &str,
    compactor_provider: &str,
    compactor_model: &str,
) -> Result<Vec<u8>, SetupError> {
    let mut document = if config_path.exists() {
        let existing = fs::read(config_path).map_err(|error| SetupError::Io(error.to_string()))?;
        serde_json::from_slice::<Value>(&existing)
            .map_err(|error| SetupError::Config(error.to_string()))?
    } else {
        Value::Object(Map::new())
    };
    let object = document
        .as_object_mut()
        .ok_or_else(|| SetupError::Config("config root must be an object".to_owned()))?;
    object.insert("config_schema_version".to_owned(), json!(1));
    let llm = object
        .entry("llm")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| SetupError::Config("llm must be an object".to_owned()))?;
    llm.insert("provider".to_owned(), json!(provider));
    llm.insert("protocol".to_owned(), json!(protocol));
    llm.insert("model".to_owned(), json!(model));
    llm.insert("reasoning_effort".to_owned(), json!(reasoning_effort));
    let history = object
        .entry("history")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| SetupError::Config("history must be an object".to_owned()))?;
    history.insert("compactor_provider".to_owned(), json!(compactor_provider));
    history.insert("compactor_model".to_owned(), json!(compactor_model));
    let provider_config = json!({"base_url": base_url, "extra_headers": {}});
    let providers = object
        .entry("providers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| SetupError::Config("providers must be an object".to_owned()))?;
    providers.insert(provider.to_owned(), provider_config);
    let mut bytes =
        serde_json::to_vec(&document).map_err(|error| SetupError::Config(error.to_string()))?;
    bytes.push(b'\n');
    let raw = crate::config::RawConfigV1::parse_json(&bytes[..bytes.len() - 1])
        .map_err(|error| SetupError::Config(error.to_string()))?;
    let mut effective = build_defaults(praana_home);
    crate::config::merge::merge_raw_into_effective(&mut effective, raw);
    crate::config::validate::validate_effective_config(&mut effective, praana_home)
        .map_err(|error| SetupError::Config(error.to_string()))?;
    Ok(bytes)
}

#[cfg(unix)]
fn set_private_mode(path: &Path, mode: u32) -> Result<(), SetupError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| SetupError::Io(error.to_string()))
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path, _mode: u32) -> Result<(), SetupError> {
    Ok(())
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), SetupError> {
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(SetupError::Io(format!(
            "config target is a symlink: {}",
            path.display()
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| SetupError::Io("config path has no parent".to_owned()))?;
    fs::create_dir_all(parent).map_err(|error| SetupError::Io(error.to_string()))?;
    let temp = parent.join(format!(".praana-config-{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(&temp)
        .map_err(|error| SetupError::Io(error.to_string()))?;
    file.write_all(bytes)
        .map_err(|error| SetupError::Io(error.to_string()))?;
    file.sync_all()
        .map_err(|error| SetupError::Io(error.to_string()))?;
    drop(file);
    set_private_mode(&temp, 0o600)?;
    fs::rename(&temp, path).map_err(|error| SetupError::Io(error.to_string()))?;
    set_private_mode(path, 0o600)?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| SetupError::Io(error.to_string()))?;
    Ok(())
}

/// Convenience status helper for callers that already loaded the credential
/// store and effective config.
pub fn setup_status(
    config: &crate::config::EffectiveConfigV1,
    credentials: &CredentialStoreV1,
    revision: u64,
) -> Result<SetupStatusDto, SetupError> {
    build_setup_status(config, credentials, revision)
}

/// Load the effective config and setup state from a loader environment.
pub fn load_setup_status(
    explicit_config: Option<&Path>,
    env: &ConfigLoaderEnv,
) -> Result<SetupStatusDto, SetupError> {
    let (config, _, _) =
        load_effective_config(explicit_config, &ConfigCliOverrides::default(), env)
            .map_err(|error| SetupError::Config(error.to_string()))?;
    let praana_home = crate::config::path::normalize_praana_home(
        env.env_vars.get("PRAANA_HOME").map(String::as_str),
        &env.home_dir,
        &env.process_cwd,
    )
    .map_err(|error| SetupError::Config(error.to_string()))?;
    let credentials = load_store(&credentials_path(&praana_home))?;
    build_setup_status(&config, &credentials, credentials.revision)
}

/// Build a default effective config for setup-only callers.
pub fn default_setup_status(praana_home: &Path) -> Result<SetupStatusDto, SetupError> {
    let config = build_defaults(praana_home);
    let credentials = load_store(&credentials_path(praana_home))?;
    build_setup_status(&config, &credentials, credentials.revision)
}
