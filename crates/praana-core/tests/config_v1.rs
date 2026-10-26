use praana_core::compaction::activate::ConfiguredCompactor;
use praana_core::compaction::creation::{
    admit_minimum_compactor_request, validate_compactor_pair_at_creation,
};
use praana_core::config::{
    load_effective_config, resolve_resume_config, ConfigCliOverrides, ConfigError, ConfigLoaderEnv,
    ConfigWarning,
};
use praana_core::credentials::credentials_path;
#[cfg(unix)]
use praana_core::credentials::{save_store, upsert_credential, CredentialStoreV1};
use praana_core::provider::{
    catalog_cache_path, endpoint_fingerprint, CatalogCacheV1, LiveModelRowV1,
    CATALOG_CACHE_SCHEMA_VERSION, CATALOG_TTL_MS,
};
use praana_core::token::Sha256Digest;
use praana_core::ui_contract::json_data::{ModelId, ProviderId};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

fn env_btree(env: HashMap<String, String>) -> BTreeMap<String, String> {
    env.into_iter().collect()
}

/// The credential store requires its parent directory to be mode 0700
/// (`prepare_parent`/`establish_private`).
#[cfg(unix)]
fn make_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(not(unix))]
fn make_private(_path: &Path) {}

fn fixture_path(relative: &str) -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir.parent().unwrap().parent().unwrap();
    root.join("tests/fixtures/rust-v2/config/v1").join(relative)
}

fn make_test_env(home: &Path, cwd: &Path, env_vars: HashMap<String, String>) -> ConfigLoaderEnv {
    ConfigLoaderEnv {
        home_dir: home.to_path_buf(),
        session_cwd: cwd.to_path_buf(),
        process_cwd: cwd.to_path_buf(),
        env_vars,
    }
}

#[test]
fn defaults_match_normative_toml() {
    let fixture_p = fixture_path("defaults.toml");
    let spec_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("docs/RUST_V2_CONFIG_SPEC.md");
    let spec_content = fs::read_to_string(&spec_path).unwrap();
    let marker = "### 5.1 Effective default TOML";
    let section_start = spec_content.find(marker).expect("section 5.1 marker");
    let code_start = spec_content[section_start..]
        .find("```toml\n")
        .expect("code block start")
        + section_start
        + "```toml\n".len();
    let code_end = spec_content[code_start..]
        .find("\n```")
        .expect("code block end")
        + code_start;
    let spec_toml = &spec_content[code_start..code_end];
    let fixture_bytes = fs::read(&fixture_p).unwrap();
    let expected_bytes = format!("{spec_toml}\n").into_bytes();
    assert_eq!(fixture_bytes, expected_bytes);
}

#[test]
fn defaults_effective_json_matches_rfc8785_fixture() {
    let home = PathBuf::from("/home/test");
    let cwd = PathBuf::from("/work/project");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, digest, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();

    let json_bytes = effective.to_canonical_json_bytes();
    let expected_fixture = fs::read(fixture_path("defaults.effective.json")).unwrap();
    let expected_str = String::from_utf8(expected_fixture).unwrap();
    let actual_str = String::from_utf8(json_bytes).unwrap();

    assert_eq!(actual_str.trim(), expected_str.trim());
    assert_eq!(digest.as_str().len(), 64);
}

#[test]
fn digest_hashes_effective_json_without_trailing_lf() {
    let home = PathBuf::from("/home/test");
    let cwd = PathBuf::from("/work/project");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, digest, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();

    let json_bytes = effective.to_canonical_json_bytes();
    let calculated = praana_core::token::Sha256Digest::digest_bytes(&json_bytes);
    assert_eq!(digest, calculated);
}

#[test]
fn digest_excludes_credentials_and_config_source_paths() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd1 = temp.path().join("project1");
    let cwd2 = temp.path().join("project2");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd1).unwrap();
    fs::create_dir_all(&cwd2).unwrap();

    let mut env_map1 = HashMap::new();
    env_map1.insert("OPENAI_API_KEY".to_string(), "sk-secret1".to_string());
    let env1 = make_test_env(&home, &cwd1, env_map1);

    let mut env_map2 = HashMap::new();
    env_map2.insert("OPENAI_API_KEY".to_string(), "sk-secret2".to_string());
    let env2 = make_test_env(&home, &cwd2, env_map2);

    let (_, digest1, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env1).unwrap();
    let (_, digest2, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env2).unwrap();

    assert_eq!(digest1, digest2);
}

#[test]
fn discovery_order_is_global_json_global_toml_cwd_json_cwd_toml() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // 1. global json: max_steps = 10
    fs::write(
        praana_home.join("praana.config.json"),
        r#"{"turn":{"max_steps":10}}"#,
    )
    .unwrap();
    // 2. global toml: max_steps = 20
    fs::write(praana_home.join("config.toml"), "[turn]\nmax_steps = 20\n").unwrap();
    // 3. cwd json: max_steps = 30
    fs::write(
        cwd.join("praana.config.json"),
        r#"{"turn":{"max_steps":30}}"#,
    )
    .unwrap();
    // 4. cwd toml: max_steps = 40
    fs::write(cwd.join("praana.config.toml"), "[turn]\nmax_steps = 40\n").unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.turn.max_steps, 40);
}

#[test]
fn explicit_cli_path_suppresses_discovery() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(praana_home.join("config.toml"), "[turn]\nmax_steps = 50\n").unwrap();
    let custom_cfg = temp.path().join("custom.toml");
    fs::write(&custom_cfg, "[turn]\nmax_steps = 99\n").unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(Some(&custom_cfg), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.turn.max_steps, 99);
}

#[test]
fn explicit_env_path_suppresses_discovery() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(praana_home.join("config.toml"), "[turn]\nmax_steps = 50\n").unwrap();
    let custom_cfg = temp.path().join("env_custom.toml");
    fs::write(&custom_cfg, "[turn]\nmax_steps = 88\n").unwrap();

    let mut env_map = HashMap::new();
    env_map.insert(
        "PRAANA_CONFIG".to_string(),
        custom_cfg.to_str().unwrap().to_string(),
    );
    let env = make_test_env(&home, &cwd, env_map);

    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.turn.max_steps, 88);
}

#[test]
fn cli_config_selector_precedes_env_selector() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cli_cfg = temp.path().join("cli.toml");
    fs::write(&cli_cfg, "[turn]\nmax_steps = 111\n").unwrap();
    let env_cfg = temp.path().join("env.toml");
    fs::write(&env_cfg, "[turn]\nmax_steps = 222\n").unwrap();

    let mut env_map = HashMap::new();
    env_map.insert(
        "PRAANA_CONFIG".to_string(),
        env_cfg.to_str().unwrap().to_string(),
    );
    let env = make_test_env(&home, &cwd, env_map);

    let (effective, _, _) =
        load_effective_config(Some(&cli_cfg), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.turn.max_steps, 111);
}

#[test]
fn missing_discovered_source_is_silent() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(None, &ConfigCliOverrides::default(), &env);
    assert!(res.is_ok());
}

#[test]
fn missing_explicit_source_is_fatal() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let missing_path = temp.path().join("missing.toml");
    let res = load_effective_config(Some(&missing_path), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::SourceInvalid(_))));
}

#[test]
fn tables_deep_merge_scalars_replace() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(
        praana_home.join("config.toml"),
        "[history]\ncompact_at = 0.70\nsafety_margin_min_tokens = 600\n",
    )
    .unwrap();
    fs::write(
        cwd.join("praana.config.toml"),
        "[history]\ncompact_at = 0.80\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.history.compact_at, 0.80);
    assert_eq!(effective.history.safety_margin_min_tokens, 600);
}

#[test]
fn arrays_replace_and_empty_array_clears() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(
        praana_home.join("config.toml"),
        "[risk]\nallow = [\"rm\", \"git_reset\"]\n",
    )
    .unwrap();
    fs::write(cwd.join("praana.config.toml"), "[risk]\nallow = []\n").unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.risk.allow, Vec::<String>::new());
}

#[test]
fn extra_headers_map_replaces_whole_map() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(
        praana_home.join("config.toml"),
        "[providers.openai.extra_headers]\nCustom-Header-A = \"valA\"\nCustom-Header-B = \"valB\"\n",
    )
    .unwrap();
    fs::write(
        cwd.join("praana.config.toml"),
        "[providers.openai.extra_headers]\nCustom-Header-C = \"valC\"\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.providers.openai.extra_headers.len(), 1);
    assert_eq!(
        effective
            .providers
            .openai
            .extra_headers
            .get("Custom-Header-C"),
        Some(&"valC".to_string())
    );
}

#[test]
fn unknown_key_is_fatal_in_every_layer() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let unknown_cfg = fixture_path("unknown-key.toml");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&unknown_cfg), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::UnknownKey(_))));
}

#[test]
fn json_null_is_not_a_delete_operator() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let null_cfg = fixture_path("json-null.json");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&null_cfg), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::InvalidType(_))));
}

#[test]
fn json_and_toml_duplicate_keys_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let dup_json = fixture_path("duplicate-key.json");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&dup_json), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::Parse(_))));
}

#[test]
fn invalid_high_precedence_value_does_not_fall_back() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(praana_home.join("config.toml"), "[turn]\nmax_steps = 20\n").unwrap();
    fs::write(
        cwd.join("praana.config.toml"),
        "[turn]\nmax_steps = 99999\n",
    )
    .unwrap(); // invalid max_steps > 1000

    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(None, &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::InvalidValue(_))));
}

#[test]
fn relative_path_uses_owning_source_directory() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(
        praana_home.join("config.toml"),
        "[tools]\nallowed_paths = [\"./global_tools\"]\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.tools.allowed_paths.len(), 1);
    let expected = praana_home
        .join("global_tools")
        .to_str()
        .unwrap()
        .replace('\\', "/");
    assert_eq!(effective.tools.allowed_paths[0], expected);
}

#[test]
fn tilde_expands_only_for_exact_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(
        praana_home.join("config.toml"),
        "[session]\nroot = \"~/my_sessions\"\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    let expected = home
        .join("my_sessions")
        .to_str()
        .unwrap()
        .replace('\\', "/");
    assert_eq!(effective.session.root, expected);
}

#[test]
fn memory_db_cannot_escape_plugin_owned_root() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let escape_cfg = fixture_path("plugin-escape.toml");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&escape_cfg), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::PathOutsidePluginRoot(_))));
}

#[test]
fn provider_urls_normalize_once_and_reject_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("url_test.toml");
    fs::write(
        &cfg_file,
        "[providers.openai]\nbase_url = \"https://api.openai.com/v1///\"\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(
        effective.providers.openai.base_url,
        "https://api.openai.com/v1"
    );
}

#[test]
fn environment_override_is_strict_and_precedes_files() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    fs::write(
        praana_home.join("config.toml"),
        "[llm]\nprovider = \"openai\"\nmodel = \"gpt-4\"\n",
    )
    .unwrap();

    let mut env_map = HashMap::new();
    env_map.insert("PRAANA_MODEL".to_string(), "gpt-5".to_string());
    let env = make_test_env(&home, &cwd, env_map);

    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.llm.model, "gpt-5");
}

#[test]
fn cli_field_override_precedes_environment() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let mut env_map = HashMap::new();
    env_map.insert("PRAANA_MODEL".to_string(), "env-model".to_string());
    let env = make_test_env(&home, &cwd, env_map);

    let cli_overrides = ConfigCliOverrides {
        model: Some("cli-model".to_string()),
        ..Default::default()
    };

    let (effective, _, _) = load_effective_config(None, &cli_overrides, &env).unwrap();
    assert_eq!(effective.llm.model, "cli-model");
}

#[test]
fn env_and_cli_overrides_use_ascii_edge_trim_and_reject_unicode_whitespace() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // 1. Env override with NBSP prefix must fail with ConfigError::InvalidValue
    let mut env_map = HashMap::new();
    env_map.insert("PRAANA_PROVIDER".to_string(), "\u{00A0}openai".to_string());
    env_map.insert("PRAANA_MODEL".to_string(), "gpt-5".to_string());
    let env = make_test_env(&home, &cwd, env_map);

    let err = load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap_err();
    match err {
        ConfigError::InvalidValue(msg) => {
            assert!(msg.contains("PRAANA_PROVIDER"));
        }
        other => panic!("expected ConfigError::InvalidValue, got {:?}", other),
    }

    // 2. CLI override with NBSP prefix must also fail with ConfigError::InvalidValue
    let mut clean_env_map = HashMap::new();
    clean_env_map.insert("PRAANA_MODEL".to_string(), "gpt-5".to_string());
    let clean_env = make_test_env(&home, &cwd, clean_env_map);
    let cli_overrides = ConfigCliOverrides {
        provider: Some("\u{00A0}openai".to_string()),
        ..Default::default()
    };
    let cli_err = load_effective_config(None, &cli_overrides, &clean_env).unwrap_err();
    match cli_err {
        ConfigError::InvalidValue(msg) => {
            assert!(msg.contains("cli --provider"));
        }
        other => panic!("expected ConfigError::InvalidValue, got {:?}", other),
    }

    // 3. ASCII whitespace (space, tab, \r, \n) is trimmed properly
    let mut ascii_trim_env_map = HashMap::new();
    ascii_trim_env_map.insert("PRAANA_PROVIDER".to_string(), " \topenai\r\n ".to_string());
    ascii_trim_env_map.insert("PRAANA_MODEL".to_string(), "  gpt-5 \n".to_string());
    let ascii_env = make_test_env(&home, &cwd, ascii_trim_env_map);
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &ascii_env).unwrap();
    assert_eq!(effective.llm.provider, "openai");
    assert_eq!(effective.llm.model, "gpt-5");
}

#[test]
fn credential_environment_does_not_select_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-secret".to_string());
    let env = make_test_env(&home, &cwd, env_map);

    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.llm.provider, "");
}

#[test]
fn secret_keys_and_headers_are_rejected_without_value_logging() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let secret_cfg = fixture_path("secret-header.toml");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&secret_cfg), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::SecretForbidden(_))));
}

#[test]
fn history_mode_accepts_only_append() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let engine_cfg = fixture_path("engine.toml");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&engine_cfg), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::ValueNotImplemented(_))));
}

#[test]
fn reasoning_replay_accepts_only_active() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("reasoning.toml");
    fs::write(&cfg_file, "[history]\nreasoning_replay = \"all\"\n").unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::ValueNotImplemented(_))));

    let cfg_file_none = temp.path().join("reasoning_none.toml");
    fs::write(&cfg_file_none, "[history]\nreasoning_replay = \"none\"\n").unwrap();
    let res_none =
        load_effective_config(Some(&cfg_file_none), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res_none, Err(ConfigError::ValueNotImplemented(_))));

    let cfg_file_invalid = temp.path().join("reasoning_invalid.toml");
    fs::write(
        &cfg_file_invalid,
        "[history]\nreasoning_replay = \"invalid\"\n",
    )
    .unwrap();
    let res_invalid = load_effective_config(
        Some(&cfg_file_invalid),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res_invalid, Err(ConfigError::InvalidValue(_))));
}

#[test]
fn openrouter_responses_is_rejected_before_auth() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = fixture_path("bad-openrouter-responses.json");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::InvalidValue(_))));
}

#[test]
fn unknown_context_window_fails_admission_not_config_loading() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("zero_cw.toml");
    fs::write(
        &cfg_file,
        "[llm]\nprovider = \"openai\"\nmodel = \"gpt-5\"\ncontext_window = 0\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(effective.llm.context_window, 0);
}

#[test]
fn context_window_validates_range_without_unsafe_warning_in_p1a() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // 0 is valid
    let cfg_0 = temp.path().join("cw_0.toml");
    fs::write(&cfg_0, "[llm]\ncontext_window = 0\n").unwrap();
    let env = make_test_env(&home, &cwd, HashMap::new());
    let (eff0, _, w0) =
        load_effective_config(Some(&cfg_0), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(eff0.llm.context_window, 0);
    assert!(!w0
        .iter()
        .any(|w| matches!(w, ConfigWarning::UnsafeContextWindow)));

    // 2048 is valid
    let cfg_2048 = temp.path().join("cw_2048.toml");
    fs::write(&cfg_2048, "[llm]\ncontext_window = 2048\n").unwrap();
    let (eff2048, _, w2048) =
        load_effective_config(Some(&cfg_2048), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(eff2048.llm.context_window, 2048);
    assert!(!w2048
        .iter()
        .any(|w| matches!(w, ConfigWarning::UnsafeContextWindow)));

    // 2000000 is valid, no warning emitted in P1A
    let cfg_2m = temp.path().join("cw_2m.toml");
    fs::write(
        &cfg_2m,
        "[llm]\nprovider = \"openai\"\nmodel = \"gpt-5\"\ncontext_window = 2000000\nunsafe_allow_context_window_increase = true\n",
    )
    .unwrap();
    let (eff2m, _, w2m) =
        load_effective_config(Some(&cfg_2m), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(eff2m.llm.context_window, 2000000);
    assert!(!w2m
        .iter()
        .any(|w| matches!(w, ConfigWarning::UnsafeContextWindow)));

    // 2047 is rejected (< 2048)
    let cfg_2047 = temp.path().join("cw_2047.toml");
    fs::write(&cfg_2047, "[llm]\ncontext_window = 2047\n").unwrap();
    let res_2047 = load_effective_config(Some(&cfg_2047), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res_2047, Err(ConfigError::InvalidValue(_))));

    // 1 is rejected
    let cfg_1 = temp.path().join("cw_1.toml");
    fs::write(&cfg_1, "[llm]\ncontext_window = 1\n").unwrap();
    let res_1 = load_effective_config(Some(&cfg_1), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res_1, Err(ConfigError::InvalidValue(_))));

    // > i32::MAX (2147483648) is rejected
    let cfg_huge = temp.path().join("cw_huge.toml");
    fs::write(&cfg_huge, "[llm]\ncontext_window = 2147483648\n").unwrap();
    let res_huge = load_effective_config(Some(&cfg_huge), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res_huge, Err(ConfigError::InvalidValue(_))));
}

#[test]
fn fallback_fields_are_all_empty_or_complete() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("bad_fallback.toml");
    fs::write(
        &cfg_file,
        "[llm]\nfallback_provider = \"openai\"\nfallback_model = \"\"\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::InvalidValue(_))));
}

#[test]
fn compactor_fields_are_both_empty_or_complete() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("bad_compactor.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"\"\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::InvalidValue(_))));
}

#[test]
fn incognito_and_plugin_none_select_identical_memory_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cli_incognito = ConfigCliOverrides {
        incognito: true,
        ..Default::default()
    };

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) = load_effective_config(None, &cli_incognito, &env).unwrap();
    assert!(effective.session.incognito);
    assert_eq!(effective.memory.plugin, "none");
}

#[test]
fn live_reload_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();

    let res = effective.request_live_reload();
    assert!(matches!(res, Err(ConfigError::ReloadUnsupported)));
}

#[test]
fn resume_reports_creation_loaded_and_applied_runtime_digests() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // Initial creation config
    let env1 = make_test_env(&home, &cwd, HashMap::new());
    let (creation_cfg, creation_digest, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env1).unwrap();

    // Source changes later: turn max_steps changed, logging level changed
    fs::write(
        cwd.join("praana.config.toml"),
        "[turn]\nmax_steps = 50\n\n[logging]\nlevel = \"debug\"\n",
    )
    .unwrap();

    let env2 = make_test_env(&home, &cwd, HashMap::new());
    let (loaded_cfg, loaded_digest, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env2).unwrap();

    let resume_result =
        resolve_resume_config(&creation_cfg, &creation_digest, &loaded_cfg, &loaded_digest)
            .unwrap();

    // Runtime config keeps creation's turn.max_steps (25), but adopts logging.level ("debug")
    assert_eq!(resume_result.runtime_config.turn.max_steps, 25);
    assert_eq!(resume_result.runtime_config.logging.level, "debug");
    assert_eq!(resume_result.creation_config_digest, creation_digest);
    assert_eq!(resume_result.loaded_config_digest, loaded_digest);
    assert_ne!(creation_digest, loaded_digest);
    assert!(resume_result.changed_since_create);
    assert!(resume_result
        .changed_keys
        .contains(&"turn.max_steps".to_string()));
}

#[test]
fn future_tables_and_values_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let future_ui = fixture_path("future-ui.toml");
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&future_ui), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::UnknownKey(_))));
}

#[test]
fn all_committed_fixtures_load_or_fail_as_expected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    let env = make_test_env(&home, &cwd, HashMap::new());

    // 1. defaults.toml -> Ok
    let (eff, _, _) = load_effective_config(
        Some(&fixture_path("defaults.toml")),
        &ConfigCliOverrides::default(),
        &env,
    )
    .unwrap();
    assert_eq!(eff.config_schema_version, 1);

    // 2. global.json -> Ok
    let (eff, _, _) = load_effective_config(
        Some(&fixture_path("global.json")),
        &ConfigCliOverrides::default(),
        &env,
    )
    .unwrap();
    assert_eq!(eff.llm.model, "gpt-5");

    // 3. project.toml -> Ok
    let (eff, _, _) = load_effective_config(
        Some(&fixture_path("project.toml")),
        &ConfigCliOverrides::default(),
        &env,
    )
    .unwrap();
    assert_eq!(eff.llm.protocol, "openai-responses-v1");

    // 4. openai-runnable.toml -> Ok
    let (eff, _, _) = load_effective_config(
        Some(&fixture_path("openai-runnable.toml")),
        &ConfigCliOverrides::default(),
        &env,
    )
    .unwrap();
    assert_eq!(eff.llm.provider, "openai");
    assert_eq!(eff.llm.model, "gpt-5.6-sol");

    // 5. openrouter-runnable.json -> Ok
    let (eff, _, _) = load_effective_config(
        Some(&fixture_path("openrouter-runnable.json")),
        &ConfigCliOverrides::default(),
        &env,
    )
    .unwrap();
    assert_eq!(eff.llm.provider, "openrouter");
    assert_eq!(eff.llm.model, "openai/gpt-5.6-sol");

    // 6. bad-clear.toml -> InvalidValue
    let res = load_effective_config(
        Some(&fixture_path("bad-clear.toml")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::InvalidValue(_))));

    // 7. bad-openrouter-responses.json -> InvalidValue
    let res = load_effective_config(
        Some(&fixture_path("bad-openrouter-responses.json")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::InvalidValue(_))));

    // 8. unknown-key.toml -> UnknownKey
    let res = load_effective_config(
        Some(&fixture_path("unknown-key.toml")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::UnknownKey(_))));

    // 9. engine.toml -> ValueNotImplemented
    let res = load_effective_config(
        Some(&fixture_path("engine.toml")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::ValueNotImplemented(_))));

    // 10. secret-header.toml -> SecretForbidden
    let res = load_effective_config(
        Some(&fixture_path("secret-header.toml")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::SecretForbidden(_))));

    // 11. plugin-escape.toml -> PathOutsidePluginRoot
    let res = load_effective_config(
        Some(&fixture_path("plugin-escape.toml")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::PathOutsidePluginRoot(_))));

    // 12. duplicate-key.json -> Parse
    let res = load_effective_config(
        Some(&fixture_path("duplicate-key.json")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::Parse(_))));

    // 13. json-null.json -> InvalidType
    let res = load_effective_config(
        Some(&fixture_path("json-null.json")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::InvalidType(_))));

    // 14. future-ui.toml -> UnknownKey
    let res = load_effective_config(
        Some(&fixture_path("future-ui.toml")),
        &ConfigCliOverrides::default(),
        &env,
    );
    assert!(matches!(res, Err(ConfigError::UnknownKey(_))));
}

#[test]
fn stacked_layer_fixtures_global_and_project_applied_together() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let praana_home = home.join(".praana");
    fs::create_dir_all(&praana_home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // Layer 1 (global): ~/.praana/praana.config.json
    let global_fixture = fixture_path("global.json");
    fs::copy(&global_fixture, praana_home.join("praana.config.json")).unwrap();

    // Layer 4 (project): ./praana.config.toml
    let project_fixture = fixture_path("project.toml");
    fs::copy(&project_fixture, cwd.join("praana.config.toml")).unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (eff, _, _) = load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();

    // §16.3 triple assertions:
    // 1. max_parallel_calls = 4 retained from global.json
    assert_eq!(eff.tools.max_parallel_calls, 4);
    // 2. tools.allowed_paths replaced by project.toml (now empty)
    assert!(eff.tools.allowed_paths.is_empty());
    // 3. risk.allow replaced by project.toml (only ["package_install"])
    assert_eq!(eff.risk.allow, vec!["package_install".to_string()]);

    // Model and provider retained from global.json, protocol from project.toml
    assert_eq!(eff.llm.provider, "openai");
    assert_eq!(eff.llm.model, "gpt-5");
    assert_eq!(eff.llm.protocol, "openai-responses-v1");
}

#[test]
fn config_snapshot_writes_mode_600_trailing_lf_and_matching_digest() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let session_dir = temp.path().join("session");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&session_dir).unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (effective, expected_digest, _) = load_effective_config(
        Some(&fixture_path("openai-runnable.toml")),
        &ConfigCliOverrides::default(),
        &env,
    )
    .unwrap();

    // 1. Write config snapshot
    let snapshot_path = effective.write_config_snapshot(&session_dir).unwrap();
    assert_eq!(snapshot_path, session_dir.join("config.snapshot.json"));
    assert!(snapshot_path.is_file());

    // 2. Check permissions on Unix: mode & 0o777 == 0o600
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(&snapshot_path).unwrap();
        let mode = metadata.permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "expected 0o600 permissions on snapshot"
        );
    }

    // 3. Check bytes: must end with byte b'\n'
    let snapshot_bytes = fs::read(&snapshot_path).unwrap();
    assert!(!snapshot_bytes.is_empty());
    assert_eq!(*snapshot_bytes.last().unwrap(), b'\n');

    // 4. Check digest: SHA-256 of bytes without trailing LF must equal config_digest_sha256()
    let bytes_without_lf = &snapshot_bytes[..snapshot_bytes.len() - 1];
    let computed_digest = praana_core::token::Sha256Digest::digest_bytes(bytes_without_lf);
    assert_eq!(computed_digest, expected_digest);
    assert_eq!(computed_digest, effective.config_digest_sha256());

    // 5. Verify second call fails with SnapshotMismatch (create_new semantics)
    let err = effective.write_config_snapshot(&session_dir).unwrap_err();
    match err {
        ConfigError::SnapshotMismatch(msg) => {
            assert!(msg.contains("snapshot already exists"));
        }
        other => panic!("expected ConfigError::SnapshotMismatch, got {:?}", other),
    }
}

#[test]
fn toml_duplicate_keys_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("duplicate-key.toml");
    fs::write(
        &cfg_file,
        "[llm]\nprovider = \"openai\"\nprovider = \"openrouter\"\n",
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::Parse(_))));
}

#[test]
fn canary_secret_values_are_never_leaked_in_errors() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let canary = "CANARY_SECRET_AUTH_987654321";
    let cfg_file = temp.path().join("secret.toml");
    fs::write(
        &cfg_file,
        format!("[providers.openai.extra_headers]\nauthorization = \"{canary}\"\n"),
    )
    .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env);
    let err = res.expect_err("must fail");
    assert!(matches!(err, ConfigError::SecretForbidden(_)));
    let err_str = err.to_string();
    assert!(
        !err_str.contains(canary),
        "secret canary must not appear in error message"
    );

    // Test Bearer secret in extra_headers
    let cfg_file2 = temp.path().join("bearer_secret.toml");
    fs::write(
        &cfg_file2,
        format!("[providers.openai.extra_headers]\nx-custom = \"Bearer {canary}\"\n"),
    )
    .unwrap();
    let res2 = load_effective_config(Some(&cfg_file2), &ConfigCliOverrides::default(), &env);
    let err2 = res2.expect_err("must fail");
    assert!(matches!(err2, ConfigError::SecretForbidden(_)));
    assert!(!err2.to_string().contains(canary));

    // Test forbidden key like api_key
    let cfg_file3 = temp.path().join("api_key_secret.toml");
    fs::write(&cfg_file3, format!("api_key = \"{canary}\"\n")).unwrap();
    let res3 = load_effective_config(Some(&cfg_file3), &ConfigCliOverrides::default(), &env);
    let err3 = res3.expect_err("must fail");
    assert!(matches!(err3, ConfigError::SecretForbidden(_)));
    assert!(!err3.to_string().contains(canary));
}

#[test]
fn path_expansion_expands_only_exact_tilde_slash() {
    use praana_core::config::path::normalize_config_path;
    let base_dir = Path::new("/workspace/project");
    let home_dir = Path::new("/home/testuser");

    // Exact ~/ expands against home_dir
    let p1 = normalize_config_path("~/data", base_dir, home_dir, "test").unwrap();
    assert_eq!(p1, "/home/testuser/data");

    // Bare ~ is relative to base_dir
    let p2 = normalize_config_path("~", base_dir, home_dir, "test").unwrap();
    assert_eq!(p2, "/workspace/project/~");

    // ~\ is relative to base_dir (converted to forward slashes in canonical path)
    let p3 = normalize_config_path("~\\data", base_dir, home_dir, "test").unwrap();
    assert_eq!(p3, "/workspace/project/~/data");

    // ~otheruser is relative to base_dir
    let p4 = normalize_config_path("~otheruser/data", base_dir, home_dir, "test").unwrap();
    assert_eq!(p4, "/workspace/project/~otheruser/data");
}

#[test]
fn memory_plugin_builtin_sqlite_returns_feature_not_implemented() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_sqlite = temp.path().join("sqlite.toml");
    fs::write(&cfg_sqlite, "[memory]\nplugin = \"builtin:sqlite\"\n").unwrap();
    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(Some(&cfg_sqlite), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::FeatureNotImplemented(_))));
}

#[test]
fn memory_selection_under_incognito_returns_none_incognito() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (eff_normal, _, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert!(!eff_normal.session.incognito);
    assert_eq!(eff_normal.memory.plugin, "none");
    let (sel_norm, rec_norm) = eff_normal.memory_selection();
    assert_eq!(sel_norm, praana_core::config::MemorySelection::None);
    assert_eq!(rec_norm, "none");

    let cli_incognito = ConfigCliOverrides {
        incognito: true,
        ..Default::default()
    };
    let (eff_incog, _, _) = load_effective_config(None, &cli_incognito, &env).unwrap();
    assert!(eff_incog.session.incognito);
    assert_eq!(eff_incog.memory.plugin, "none");
    let (sel_incog, rec_incog) = eff_incog.memory_selection();
    assert_eq!(sel_incog, praana_core::config::MemorySelection::None);
    assert_eq!(rec_incog, "none_incognito");
}

#[test]
#[cfg(unix)]
fn broad_file_permissions_emit_warning() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("broad.toml");
    fs::write(&cfg_file, "[turn]\nmax_steps = 10\n").unwrap();
    // Set 0o644 (readable by group and other)
    fs::set_permissions(&cfg_file, fs::Permissions::from_mode(0o644)).unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (_, _, warnings) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    assert!(warnings
        .iter()
        .any(|w| matches!(w, ConfigWarning::PermissionsBroad(_))));

    // Set 0o600 (readable only by owner)
    fs::set_permissions(&cfg_file, fs::Permissions::from_mode(0o600)).unwrap();
    let (_, _, warnings2) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    assert!(!warnings2
        .iter()
        .any(|w| matches!(w, ConfigWarning::PermissionsBroad(_))));
}

#[test]
fn extra_headers_validation_and_case_preservation() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // Valid extra headers preserves casing
    let cfg_file = temp.path().join("headers.toml");
    fs::write(
        &cfg_file,
        "[providers.openai.extra_headers]\nX-Custom-Foo = \"bar\"\n",
    )
    .unwrap();
    let env = make_test_env(&home, &cwd, HashMap::new());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(
        eff.providers.openai.extra_headers.get("X-Custom-Foo"),
        Some(&"bar".to_string())
    );

    // Invalid HTTP header token name
    let cfg_bad_token = temp.path().join("bad_token.toml");
    fs::write(
        &cfg_bad_token,
        "[providers.openai.extra_headers]\n\"Bad Header@\" = \"val\"\n",
    )
    .unwrap();
    let res_bad = load_effective_config(Some(&cfg_bad_token), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res_bad, Err(ConfigError::InvalidValue(_))));

    // Case-insensitive duplicate in same map
    let cfg_dup = temp.path().join("dup_headers.toml");
    fs::write(
        &cfg_dup,
        "[providers.openai.extra_headers]\nX-Custom = \"1\"\nx-custom = \"2\"\n",
    )
    .unwrap();
    let res_dup = load_effective_config(Some(&cfg_dup), &ConfigCliOverrides::default(), &env);
    assert!(matches!(res_dup, Err(ConfigError::InvalidValue(_))));
}

#[test]
fn allowed_paths_deduplication_preserves_first_seen_order() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = cwd.join("paths.toml");
    fs::write(
        &cfg_file,
        "[tools]\nallowed_paths = [\"./shared\", \"./other\", \"./shared\"]\n",
    )
    .unwrap();
    let env = make_test_env(&home, &cwd, HashMap::new());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let shared_norm = cwd.join("shared").to_str().unwrap().replace('\\', "/");
    let other_norm = cwd.join("other").to_str().unwrap().replace('\\', "/");
    assert_eq!(eff.tools.allowed_paths, vec![shared_norm, other_norm]);
}

#[test]
#[cfg(unix)]
fn dangling_symlink_in_discovery_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // Create a dangling symlink in cwd: praana.config.json -> nonexistent
    std::os::unix::fs::symlink(cwd.join("nonexistent.json"), cwd.join("praana.config.json"))
        .unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let res = load_effective_config(None, &ConfigCliOverrides::default(), &env);
    assert!(matches!(res, Err(ConfigError::SourceInvalid(_))));
}

/// P5-7 headline: a complete bundled pair (`openai` + `gpt-5.6-sol`)
/// loads without `CONFIG_FEATURE_NOT_IMPLEMENTED` and passes the creation gate
/// (trusted window, strict-schema, credential presence, admission) without a
/// fidelity manifest — the bundled row is `self_compaction: Unvalidated`.
#[test]
fn phase5_compactor_gate() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();

    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(eff.history.compactor_provider, "openai");
    assert_eq!(eff.history.compactor_model, "gpt-5.6-sol");

    let gate = validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map));
    assert!(
        gate.is_ok(),
        "complete bundled pair must pass the P5-7 gate: {:?}",
        gate.err()
    );
}

/// P5-7: the empty pair stays legal and inert. No compactor capability,
/// credential, or admission check runs, and `CONFIG_COMPACTOR_REQUIRED` is
/// never raised (no bundled profile is `Validated`). Proof that no check ran:
/// the credential store at this home is deliberately corrupt, so any
/// credential-presence check would have failed; the gate still returns Ok.
#[test]
fn phase5_empty_compactor_pair_loads_and_runs_no_checks() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    // A corrupt credential store: `load_store` would error on it.
    fs::write(credentials_path(&home), "{not valid json\n").unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (eff, _, _) = load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert!(eff.history.compactor_provider.is_empty());
    assert!(eff.history.compactor_model.is_empty());

    let gate = validate_compactor_pair_at_creation(&eff, &home, 2_000, &BTreeMap::new());
    assert!(
        gate.is_ok(),
        "empty pair must stay inert and never raise CONFIG_COMPACTOR_REQUIRED: {:?}",
        gate.err()
    );
}

/// P5-7: a one-sided pair stays `CONFIG_INVALID_VALUE` (both directions).
#[test]
fn phase5_one_sided_compactor_pair_is_invalid_value() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    for (name, section) in [
        (
            "provider_only",
            "[history]\ncompactor_provider = \"openai\"\n",
        ),
        (
            "model_only",
            "[history]\ncompactor_model = \"gpt-5.6-sol\"\n",
        ),
    ] {
        let cfg_file = temp.path().join(format!("compactor_one_sided_{name}.toml"));
        fs::write(&cfg_file, section).unwrap();
        let env = make_test_env(&home, &cwd, HashMap::new());
        let res = load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env);
        let error = res.expect_err("one-sided pair must be rejected");
        assert!(
            matches!(error, ConfigError::InvalidValue(_)),
            "expected InvalidValue, got {error:?}"
        );
        assert!(
            error.to_string().contains("CONFIG_INVALID_VALUE"),
            "diagnostic carries the canonical code: {error}"
        );
    }
}

/// P5-7: a complete pair with an unknown model is rejected with a clear,
/// specific error; no window is fabricated.
#[test]
fn phase5_complete_pair_unknown_model_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_unknown.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"not-a-real-model\"\n",
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let error = validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map))
        .expect_err("unknown compactor model must be rejected");
    let text = error.to_string();
    assert!(
        text.contains("CONFIG_COMPACTOR_REQUIRED"),
        "diagnostic carries the canonical code: {text}"
    );
    assert!(
        text.contains("no trusted window"),
        "specific reason must be stated: {text}"
    );
}

/// P5-7: a complete pair whose profile has an untrusted window is rejected.
/// An openrouter compactor with a custom endpoint never trusts a live catalog
/// cache, so a non-bundled model has no trusted window.
#[test]
fn phase5_complete_pair_untrusted_window_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    // Populate a cache file, but the configured endpoint is custom, so the
    // cache is never trusted.
    let now = 2_000i64;
    let cache = CatalogCacheV1 {
        schema_version: CATALOG_CACHE_SCHEMA_VERSION,
        provider: ProviderId::from_canonical_str("openrouter").unwrap(),
        endpoint_fingerprint: endpoint_fingerprint("https://openrouter.ai/api/v1").unwrap(),
        fetched_at_ms: now,
        expires_at_ms: now + CATALOG_TTL_MS,
        etag: None,
        body_sha256: Sha256Digest::digest_bytes(b"catalog body"),
        models: vec![LiveModelRowV1 {
            provider: ProviderId::from_canonical_str("openrouter").unwrap(),
            model_id: ModelId::from_canonical_str("some-live-model").unwrap(),
            display_name: "Live model".to_owned(),
            context_length: Some(4096),
            max_completion_tokens: Some(2048),
            supported_parameters: Vec::new(),
            reasoning_efforts: Vec::new(),
        }],
    };
    fs::create_dir_all(catalog_cache_path(&home).parent().unwrap()).unwrap();
    fs::write(
        catalog_cache_path(&home),
        serde_json::to_vec(&cache).unwrap(),
    )
    .unwrap();

    let cfg_file = temp.path().join("compactor_untrusted.toml");
    fs::write(
        &cfg_file,
        r#"[history]
compactor_provider = "openrouter"
compactor_model = "some-live-model"
[providers.openrouter]
base_url = "http://127.0.0.1:9/v1"
"#,
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENROUTER_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let error = validate_compactor_pair_at_creation(&eff, &home, now, &env_btree(env_map))
        .expect_err("untrusted compactor window must be rejected");
    let text = error.to_string();
    assert!(
        text.contains("no trusted window"),
        "specific reason must be stated: {text}"
    );
}

/// P5-7: a complete pair whose resolved profile lacks `strict_json_schema` is
/// rejected. Live catalog rows never claim strict schema, so an unexpired
/// official OpenRouter cache row exercises the check without a network call.
#[test]
fn phase5_complete_pair_missing_strict_json_schema_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let now = 2_000i64;
    let cache = CatalogCacheV1 {
        schema_version: CATALOG_CACHE_SCHEMA_VERSION,
        provider: ProviderId::from_canonical_str("openrouter").unwrap(),
        endpoint_fingerprint: endpoint_fingerprint("https://openrouter.ai/api/v1").unwrap(),
        fetched_at_ms: now,
        expires_at_ms: now + CATALOG_TTL_MS,
        etag: None,
        body_sha256: Sha256Digest::digest_bytes(b"catalog body"),
        models: vec![LiveModelRowV1 {
            provider: ProviderId::from_canonical_str("openrouter").unwrap(),
            model_id: ModelId::from_canonical_str("some-live-model").unwrap(),
            display_name: "Live model".to_owned(),
            context_length: Some(4096),
            max_completion_tokens: Some(2048),
            supported_parameters: Vec::new(),
            reasoning_efforts: Vec::new(),
        }],
    };
    fs::create_dir_all(catalog_cache_path(&home).parent().unwrap()).unwrap();
    fs::write(
        catalog_cache_path(&home),
        serde_json::to_vec(&cache).unwrap(),
    )
    .unwrap();

    let cfg_file = temp.path().join("compactor_no_strict.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openrouter\"\ncompactor_model = \"some-live-model\"\n",
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENROUTER_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let error = validate_compactor_pair_at_creation(&eff, &home, now, &env_btree(env_map))
        .expect_err("compactor profile without strict JSON schema must be rejected");
    let text = error.to_string();
    assert!(
        text.contains("does not support strict JSON schema"),
        "specific reason must be stated: {text}"
    );
}

/// P5-7: a complete pair with no credential available is rejected at creation.
/// The check is presence-only: the secret value never appears in the error,
/// logs, or snapshot. A marker value placed in the environment is never
/// echoed, and the canonical config/snapshot bytes contain no credential.
#[test]
fn phase5_complete_pair_missing_credential_rejected_without_secret_leak() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();

    // No OPENAI_API_KEY; an unrelated marker secret must never leak.
    let mut env_map = HashMap::new();
    env_map.insert(
        "SOME_OTHER_VAR".to_string(),
        "sk-super-secret-marker".to_string(),
    );
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let error = validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map))
        .expect_err("complete pair without a credential must be rejected");
    let text = error.to_string();
    assert!(
        text.contains("CONFIG_COMPACTOR_REQUIRED"),
        "diagnostic carries the canonical code: {text}"
    );
    assert!(
        text.contains("no credential is available"),
        "specific reason must be stated: {text}"
    );
    assert!(
        !text.contains("sk-super-secret-marker"),
        "secret value leaked into the error: {text}"
    );
    let canonical = String::from_utf8(eff.to_canonical_json_bytes()).unwrap();
    assert!(
        !canonical.contains("sk-super-secret-marker"),
        "secret value leaked into the config snapshot: {canonical}"
    );
}

/// P5-7: an env credential that exists but is invalid (empty, whitespace-edged,
/// newline, NUL) must not count as present — runtime
/// `resolve_from_process_env` rejects it via `validate_credential_value`, so
/// creation must reject it too instead of passing and failing later at
/// compaction time.
#[test]
fn phase5_complete_pair_invalid_env_credential_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();

    for (name, invalid_value) in [
        ("empty", ""),
        ("leading_space", " sk-x"),
        ("trailing_space", "sk-x "),
        ("newline", "sk-x\n"),
        ("embedded_nul", "sk-x\0y"),
    ] {
        let mut env_map = HashMap::new();
        env_map.insert("OPENAI_API_KEY".to_string(), invalid_value.to_string());
        let env = make_test_env(&home, &cwd, env_map.clone());
        let (eff, _, _) =
            load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
        let error = validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map))
            .expect_err("invalid env credential must be rejected at creation");
        let text = error.to_string();
        assert!(
            text.contains("CONFIG_COMPACTOR_REQUIRED"),
            "{name}: diagnostic carries the canonical code: {text}"
        );
        // The empty value is a substring of every string; assert non-leak
        // only for values that actually carry secret-looking content.
        if !invalid_value.is_empty() {
            assert!(
                !text.contains(invalid_value),
                "{name}: supplied value leaked into the error: {text}"
            );
        }
    }
}

/// P5-7: precedence keeps a valid store row usable even when the env var is
/// present but invalid. A valid store row alone is enough.
///
/// Unix-only: on non-unix `load_store` always fails with `UnsafePermissions`
/// (current-user ACL enforcement is unavailable), so a store row can never be
/// read back to satisfy credential presence.
#[cfg(unix)]
#[test]
fn phase5_complete_pair_invalid_env_with_valid_store_row_accepted() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let mut store = CredentialStoreV1::empty();
    upsert_credential(
        &mut store,
        "openai",
        "sk-valid-store-row".to_owned(),
        1_700_000_000_000,
    )
    .unwrap();
    save_store(&credentials_path(&home), &store).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();

    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), " sk-bad-env".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map))
        .expect("valid store row must satisfy credential presence even with an invalid env value");
}

/// P5-7: compactor-admission failure is rejected at creation. The minimum
/// request (control prompt, schema, `Rout`) must be admissible against the
/// compactor model's window; a profile whose window cannot fit it fails.
#[test]
fn phase5_complete_pair_admission_failure_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();

    // Resolve the real compactor, then shrink its trusted window until the
    // minimum request cannot fit.
    let mut tiny = ConfiguredCompactor::resolve(&eff, &home, 2_000).unwrap();
    tiny.profile.context_window_tokens = 200;
    tiny.profile.max_output_tokens = 100;
    tiny.profile.min_output_tokens = 1;
    let error = admit_minimum_compactor_request(&eff, &tiny)
        .expect_err("unadmissible minimum compactor request must be rejected");
    let text = error.to_string();
    assert!(
        text.contains("CONFIG_COMPACTOR_REQUIRED"),
        "diagnostic carries the canonical code: {text}"
    );
    assert!(
        text.contains("admission failed"),
        "specific reason must be stated: {text}"
    );
}

/// P5-7: a complete pair uses no network (the base URL points at a closed
/// loopback port; any connect attempt would fail) and does not read a fidelity
/// manifest (the bundled row is `self_compaction: Unvalidated` and resolves
/// without one).
#[test]
fn phase5_complete_pair_uses_no_network_and_no_fidelity_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_no_network.toml");
    fs::write(
        &cfg_file,
        r#"[history]
compactor_provider = "openai"
compactor_model = "gpt-5.6-sol"
[providers.openai]
base_url = "http://127.0.0.1:1/v1"
"#,
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let gate = validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map));
    assert!(
        gate.is_ok(),
        "creation gate must not touch the network: {:?}",
        gate.err()
    );
}

/// P5-7: a pre-Phase-5 snapshot (frozen empty pair) resumes unchanged: the
/// snapshot bytes are not rewritten, resume keeps the frozen creation
/// configuration, the loaded config's complete pair only warns, and the
/// session is not compaction-eligible.
#[test]
fn phase5_pre_phase5_snapshot_resumes_with_frozen_empty_pair() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    let session_dir = home.join("sessions/session-00000000000000000000000001");
    fs::create_dir_all(&session_dir).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let env = make_test_env(&home, &cwd, HashMap::new());
    let (creation, creation_digest, _) =
        load_effective_config(None, &ConfigCliOverrides::default(), &env).unwrap();
    assert!(creation.history.compactor_provider.is_empty());
    assert!(creation.history.compactor_model.is_empty());
    let snapshot_path = creation.write_config_snapshot(&session_dir).unwrap();
    let snapshot_before = fs::read(&snapshot_path).unwrap();

    // The user later configures a complete pair; resume must load it (it may
    // only warn) and keep the frozen creation configuration.
    let cfg_file = temp.path().join("compactor_later.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();
    let (loaded, loaded_digest, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    assert_eq!(loaded.history.compactor_provider, "openai");

    let result = resolve_resume_config(&creation, &creation_digest, &loaded, &loaded_digest)
        .expect("resume must not newly reject a pre-P5 snapshot");
    assert!(result.changed_since_create);
    assert!(result.runtime_config.history.compactor_provider.is_empty());
    assert!(result.runtime_config.history.compactor_model.is_empty());
    assert_eq!(fs::read(&snapshot_path).unwrap(), snapshot_before);
}

/// P5-7: the config digest depends only on the config text, not on the
/// environment, catalog cache contents, or clock. Same config text must yield
/// the same digest even with different env vars and a populated catalog cache.
#[test]
fn phase5_config_digest_stable_across_env_and_catalog_cache() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();

    let mut env_a = HashMap::new();
    env_a.insert("OPENAI_API_KEY".to_string(), "sk-key-a".to_string());
    let env_a = make_test_env(&home, &cwd, env_a);
    let env_b = make_test_env(&home, &cwd, HashMap::new());
    let (_, digest_a, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env_a).unwrap();
    let (_, digest_b, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env_b).unwrap();
    assert_eq!(digest_a, digest_b);

    // A populated catalog cache under the same home must not move the digest.
    let now = 2_000i64;
    let cache = CatalogCacheV1 {
        schema_version: CATALOG_CACHE_SCHEMA_VERSION,
        provider: ProviderId::from_canonical_str("openrouter").unwrap(),
        endpoint_fingerprint: endpoint_fingerprint("https://openrouter.ai/api/v1").unwrap(),
        fetched_at_ms: now,
        expires_at_ms: now + CATALOG_TTL_MS,
        etag: None,
        body_sha256: Sha256Digest::digest_bytes(b"catalog body"),
        models: vec![LiveModelRowV1 {
            provider: ProviderId::from_canonical_str("openrouter").unwrap(),
            model_id: ModelId::from_canonical_str("some-live-model").unwrap(),
            display_name: "Live model".to_owned(),
            context_length: Some(4096),
            max_completion_tokens: Some(2048),
            supported_parameters: Vec::new(),
            reasoning_efforts: Vec::new(),
        }],
    };
    fs::create_dir_all(catalog_cache_path(&home).parent().unwrap()).unwrap();
    fs::write(
        catalog_cache_path(&home),
        serde_json::to_vec(&cache).unwrap(),
    )
    .unwrap();
    let (_, digest_after_cache, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env_b).unwrap();
    assert_eq!(digest_b, digest_after_cache);
}

// --- R3: a store error must not mask a valid env credential ---

/// R3: a corrupt credential store does not block creation when a valid env
/// credential is present. The env var is checked first; a valid value
/// satisfies presence and `load_store` is never consulted, so the corrupt
/// store is irrelevant.
#[test]
fn phase5_complete_pair_corrupt_store_with_valid_env_accepted() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    // A corrupt credential store: `load_store` would error on it.
    fs::write(credentials_path(&home), "{not valid json\n").unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map))
        .expect("a valid env credential must satisfy presence even with a corrupt store");
}

/// R3: a corrupt credential store with no valid env credential is rejected,
/// and the error mentions the store problem as well as the missing credential.
#[test]
fn phase5_complete_pair_corrupt_store_no_env_mentions_store_problem() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    fs::write(credentials_path(&home), "{not valid json\n").unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();
    // No valid env credential.
    let env = make_test_env(&home, &cwd, HashMap::new());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let error = validate_compactor_pair_at_creation(&eff, &home, 2_000, &BTreeMap::new())
        .expect_err("corrupt store and no env credential must be rejected");
    let text = error.to_string();
    assert!(
        text.contains("CONFIG_COMPACTOR_REQUIRED"),
        "diagnostic carries the canonical code: {text}"
    );
    assert!(
        text.contains("no credential is available"),
        "the missing-credential reason must be stated: {text}"
    );
    assert!(
        text.contains("cannot be verified") || text.contains("CREDENTIAL_STORE_INVALID"),
        "the store problem must be mentioned: {text}"
    );
}

/// R3: a valid env credential satisfies presence without `load_store`'s side
/// effect. `load_store` -> `prepare_parent` runs `create_dir_all` and enforces
/// mode 0700 on the home directory. With a valid env var, the gate must not
/// call `load_store`, so a home directory at mode 0755 keeps mode 0755.
#[cfg(unix)]
#[test]
fn phase5_valid_env_does_not_enforce_home_mode() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    // Deliberately 0755 (not the 0700 `load_store` would enforce).
    fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map.clone());
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    validate_compactor_pair_at_creation(&eff, &home, 2_000, &env_btree(env_map))
        .expect("valid env credential must be accepted");

    let mode = fs::metadata(&home).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o755,
        "the home directory mode must be unchanged (no load_store side effect)"
    );
}

// --- R4: admit_minimum_compactor_request must not panic on a bad ULID ---

/// R4: `admit_minimum_compactor_request` builds a synthetic source turn with a
/// canonical ULID. The code now maps a parse failure into a `ConfigError`
/// instead of panicking via `.expect(...)`. The canonical constant used in
/// production parses, so the helper succeeds for a real compactor. (This also
/// documents the `pub #[doc(hidden)]` surface that `tests/config_v1.rs` calls.)
#[test]
fn phase5_admit_minimum_request_uses_valid_canonical_ulid() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("cwd");
    fs::create_dir_all(&home).unwrap();
    make_private(&home);
    fs::create_dir_all(&cwd).unwrap();

    let cfg_file = temp.path().join("compactor_complete.toml");
    fs::write(
        &cfg_file,
        "[history]\ncompactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\"\n",
    )
    .unwrap();
    let mut env_map = HashMap::new();
    env_map.insert("OPENAI_API_KEY".to_string(), "sk-test-key".to_string());
    let env = make_test_env(&home, &cwd, env_map);
    let (eff, _, _) =
        load_effective_config(Some(&cfg_file), &ConfigCliOverrides::default(), &env).unwrap();
    let compactor = ConfiguredCompactor::resolve(&eff, &home, 2_000).unwrap();
    admit_minimum_compactor_request(&eff, &compactor)
        .expect("the synthetic canonical ULID must parse and the minimum request must admit");
}
