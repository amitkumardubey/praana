use praana_core::config::{
    load_effective_config, resolve_resume_config, ConfigCliOverrides, ConfigError, ConfigLoaderEnv,
    ConfigWarning,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
    let calculated = praana_core::token::Sha256Digest::from_bytes(&json_bytes);
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

    // 5. openrouter-runnable.json -> Ok
    let (eff, _, _) = load_effective_config(
        Some(&fixture_path("openrouter-runnable.json")),
        &ConfigCliOverrides::default(),
        &env,
    )
    .unwrap();
    assert_eq!(eff.llm.provider, "openrouter");

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
    let computed_digest = praana_core::token::Sha256Digest::from_bytes(bytes_without_lf);
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
