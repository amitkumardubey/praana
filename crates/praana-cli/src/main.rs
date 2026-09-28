//! PRAANA Rust v2 headless CLI: `praana run` / `praana resume`.
//!
//! Grammar, stdout/stderr split, exit statuses, and resume-ID placement follow
//! the P3D process contract in `docs/RUST_V2_IMPLEMENTATION_HANDOFF.md`.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use praana_core::clock::SystemClock;
use praana_core::config::path::normalize_praana_home;
use praana_core::config::{
    load_effective_config, resolve_resume_config, ConfigCliOverrides, ConfigLoaderEnv,
    EffectiveConfigV1,
};
use praana_core::id::{IdGenerator, MonotonicUlidGenerator};
use praana_core::protocol::errors::{ErrorClass, ProtocolError};
use praana_core::protocol::events::InterruptionReason;
use praana_core::protocol::id::SessionId;
use praana_core::turn::provider::OpenAiStepProvider;
use praana_core::turn::{
    AcceptedStepSink, HeadlessLoop, LoopConfig, LoopFault, TurnError, TurnReport,
};
use praana_core::ui_contract::ResumeSelector;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const TOP_HELP: &str = "\
Usage: praana <command> [options]

Commands:
  run      Run a headless task from a prompt
  resume   Resume an existing session

Options:
  --help     Print help
  --version  Print version
";

const RUN_HELP: &str = "\
Usage: praana run [--config <path>] [--provider <id>] [--protocol <name>]
                  [--model <id>] [--context-window <n>] [--reasoning <level>]
                  [--max-output-tokens <n>] [--max-steps <n>] [--incognito]
                  [--debug] <prompt>
";

const RESUME_HELP: &str = "Usage: praana resume [--config <path>] [--debug] <session>\n";

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RunArgs {
    config: Option<String>,
    prompt: String,
    provider: Option<String>,
    protocol: Option<String>,
    model: Option<String>,
    context_window: Option<String>,
    reasoning: Option<String>,
    max_output_tokens: Option<String>,
    max_steps: Option<String>,
    incognito: bool,
    debug: bool,
}

struct ResumeArgs {
    config: Option<String>,
    debug: bool,
    selector: String,
}

enum Invocation {
    Help(&'static str),
    Version,
    Run(RunArgs),
    Resume(ResumeArgs),
}

#[derive(Clone, Copy, PartialEq)]
enum Sub {
    None,
    Run,
    Resume,
}

fn usage_exit() -> ! {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(
        err,
        "usage: praana [--help] [--version] <command> [options]"
    );
    let _ = writeln!(
        err,
        "       praana run [--config <path>] [--provider <id>] [--protocol <name>] \
         [--model <id>] [--context-window <n>] [--reasoning <level>] \
         [--max-output-tokens <n>] [--max-steps <n>] [--incognito] [--debug] <prompt>"
    );
    let _ = writeln!(
        err,
        "       praana resume [--config <path>] [--debug] <session>"
    );
    let _ = err.flush();
    std::process::exit(2);
}

fn print_help(text: &str) -> ! {
    print!("{text}");
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

fn print_version() -> ! {
    println!("praana {}", env!("CARGO_PKG_VERSION"));
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

fn next_value(args: &[String], index: usize) -> Option<String> {
    let value = args.get(index + 1)?;
    if value.starts_with("--") {
        return None;
    }
    Some(value.clone())
}

fn parse(args: &[String]) -> Invocation {
    // Informational forms are exact: `--help`/`--version` alone, or directly
    // after `run`/`resume`. Anything else beside them is a grammar error.
    if args.iter().any(|arg| arg == "--help" || arg == "--version") {
        return match args {
            [flag] if flag == "--help" => Invocation::Help(TOP_HELP),
            [flag] if flag == "--version" => Invocation::Version,
            [sub, flag] if *sub == "run" && flag == "--help" => Invocation::Help(RUN_HELP),
            [sub, flag] if *sub == "resume" && flag == "--help" => Invocation::Help(RESUME_HELP),
            [sub, flag] if (*sub == "run" || *sub == "resume") && flag == "--version" => {
                Invocation::Version
            }
            _ => usage_exit(),
        };
    }

    let mut sub = Sub::None;
    let mut config: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut protocol: Option<String> = None;
    let mut model: Option<String> = None;
    let mut context_window: Option<String> = None;
    let mut reasoning: Option<String> = None;
    let mut max_output_tokens: Option<String> = None;
    let mut max_steps: Option<String> = None;
    let mut incognito = false;
    let mut debug = false;
    let mut prompt: Option<String> = None;
    let mut selector: Option<String> = None;
    let mut flags_seen: Vec<String> = Vec::new();
    let mut end_of_flags = false;
    let mut index = 0;

    while index < args.len() {
        let token = &args[index];
        if !end_of_flags && token == "--" {
            end_of_flags = true;
            index += 1;
            continue;
        }
        if !end_of_flags && token.starts_with('-') {
            // Single-dash tokens and bare `-` are never valid.
            let Some(name) = token.strip_prefix("--") else {
                usage_exit();
            };
            if name.is_empty() {
                usage_exit();
            }
            if flags_seen.iter().any(|seen| seen == name) {
                usage_exit();
            }
            flags_seen.push(name.to_owned());
            match name {
                "config" => {
                    let value = next_value(args, index).unwrap_or_else(|| usage_exit());
                    config = Some(value);
                    index += 2;
                }
                "provider" | "protocol" | "model" | "context-window" | "reasoning"
                | "max-output-tokens" | "max-steps" => {
                    if sub != Sub::Run {
                        usage_exit();
                    }
                    let value = next_value(args, index).unwrap_or_else(|| usage_exit());
                    match name {
                        "provider" => provider = Some(value),
                        "protocol" => protocol = Some(value),
                        "model" => model = Some(value),
                        "context-window" => context_window = Some(value),
                        "reasoning" => reasoning = Some(value),
                        "max-output-tokens" => max_output_tokens = Some(value),
                        _ => max_steps = Some(value),
                    }
                    index += 2;
                }
                "incognito" => {
                    if sub != Sub::Run {
                        usage_exit();
                    }
                    incognito = true;
                    index += 1;
                }
                "debug" => {
                    if sub == Sub::None {
                        usage_exit();
                    }
                    debug = true;
                    index += 1;
                }
                _ => usage_exit(),
            }
            continue;
        }

        match sub {
            Sub::None => {
                if token == "run" {
                    sub = Sub::Run;
                } else if token == "resume" {
                    sub = Sub::Resume;
                } else {
                    usage_exit();
                }
            }
            Sub::Run => {
                if prompt.is_some() {
                    usage_exit();
                }
                prompt = Some(token.clone());
            }
            Sub::Resume => {
                if selector.is_some() {
                    usage_exit();
                }
                selector = Some(token.clone());
            }
        }
        index += 1;
    }

    match sub {
        Sub::None => usage_exit(),
        Sub::Run => {
            let prompt = match prompt {
                Some(text) if !text.is_empty() => text,
                _ => usage_exit(),
            };
            Invocation::Run(RunArgs {
                config,
                prompt,
                provider,
                protocol,
                model,
                context_window,
                reasoning,
                max_output_tokens,
                max_steps,
                incognito,
                debug,
            })
        }
        Sub::Resume => {
            let selector = match selector {
                Some(text) if !text.is_empty() => text,
                _ => usage_exit(),
            };
            Invocation::Resume(ResumeArgs {
                config,
                debug,
                selector,
            })
        }
    }
}

fn parse_number<T: std::str::FromStr>(flag: &str, value: &str) -> T {
    value.parse().unwrap_or_else(|_| {
        eprintln!("error: invalid value for {flag}: {value}");
        usage_exit()
    })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn loader_env(env_vars: &HashMap<String, String>, cwd: &Path) -> ConfigLoaderEnv {
    let home_dir = env_vars
        .get("HOME")
        .or_else(|| env_vars.get("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.to_path_buf());
    ConfigLoaderEnv {
        home_dir,
        session_cwd: cwd.to_path_buf(),
        process_cwd: cwd.to_path_buf(),
        env_vars: env_vars.clone(),
    }
}

fn workspace_dir() -> PathBuf {
    match std::env::current_dir() {
        Ok(path) if path.is_dir() => path,
        _ => {
            eprintln!("error: workspace is not a directory");
            std::process::exit(2);
        }
    }
}

fn class_name(class: &ErrorClass) -> String {
    serde_json::to_value(class)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn print_diagnostic(error: &ProtocolError) {
    eprintln!("{}: {}", error.code, class_name(&error.class));
}

fn turn_error_text(error: &TurnError) -> String {
    match error {
        TurnError::Failed(message) | TurnError::Durability(message) => message.clone(),
        TurnError::InjectedCrash => "injected crash".to_owned(),
        TurnError::Provider(failure) => format!(
            "{}: {}",
            failure.error.code,
            class_name(&failure.error.class)
        ),
    }
}

fn print_resume_id(session_id: &str) {
    let selector = session_id.get(..12).unwrap_or(session_id);
    eprintln!("Resume ID: {selector}");
}

fn healthy(headless: &HeadlessLoop) -> bool {
    headless.event_kinds().is_ok()
}

fn finish_report(
    result: Result<TurnReport, TurnError>,
    headless: &HeadlessLoop,
    session_id: &str,
    signal_code: i32,
) -> i32 {
    match result {
        Ok(report) => {
            let exit = match &report.interruption {
                // A committed turn exits 0 even when a signal arrived late.
                None => 0,
                Some(InterruptionReason::UserAbort) => {
                    if signal_code != 0 {
                        signal_code
                    } else {
                        130
                    }
                }
                // Cancellation wins over admission, prepare, and provider rows.
                Some(_) if signal_code != 0 => signal_code,
                Some(InterruptionReason::ActiveTurnTooLarge) => 2,
                Some(_) => 1,
            };
            if let Some(diagnostic) = &report.diagnostic {
                print_diagnostic(diagnostic);
            }
            if healthy(headless) {
                print_resume_id(session_id);
            }
            exit
        }
        Err(TurnError::Durability(message)) => {
            eprintln!("error: {message}");
            1
        }
        Err(TurnError::InjectedCrash) => {
            eprintln!("error: injected crash");
            1
        }
        Err(TurnError::Provider(failure)) => {
            print_diagnostic(&failure.error);
            if healthy(headless) {
                print_resume_id(session_id);
            }
            1
        }
        Err(TurnError::Failed(message)) => {
            eprintln!("error: {message}");
            if healthy(headless) {
                print_resume_id(session_id);
            }
            1
        }
    }
}

// ---------------------------------------------------------------------------
// Stdout: accepted text only, with the LF rule
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StdoutSink {
    last_byte: Option<u8>,
}

impl StdoutSink {
    fn write_bytes(&mut self, bytes: &[u8]) {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(bytes);
        let _ = stdout.flush();
        self.last_byte = bytes.last().copied();
    }

    fn finish(&mut self) {
        if self.last_byte.is_some() && self.last_byte != Some(b'\n') {
            self.write_bytes(b"\n");
        }
    }
}

impl AcceptedStepSink for StdoutSink {
    fn on_accepted_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.write_bytes(text.as_bytes());
        if self.last_byte != Some(b'\n') {
            self.write_bytes(b"\n");
        }
    }
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

fn spawn_signal_task(token: CancellationToken, code: Arc<AtomicI32>, notify: Arc<Notify>) {
    #[cfg(unix)]
    {
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let Ok(mut sigint) = signal(SignalKind::interrupt()) else {
                return;
            };
            let Ok(mut sigterm) = signal(SignalKind::terminate()) else {
                return;
            };
            let exit_code = tokio::select! {
                _ = sigint.recv() => 130,
                _ = sigterm.recv() => 143,
            };
            code.store(exit_code, Ordering::SeqCst);
            token.cancel();
            notify.notify_one();
            // A second signal may force exit but never writes a synthetic
            // accepted step.
            tokio::select! {
                _ = sigint.recv() => {}
                _ = sigterm.recv() => {}
            }
            std::process::exit(exit_code);
        });
    }
    #[cfg(not(unix))]
    {
        let _ = (token, code, notify);
    }
}

async fn wait_for_grace(notify: &Notify, grace: Duration) {
    notify.notified().await;
    tokio::time::sleep(grace).await;
}

// ---------------------------------------------------------------------------
// Turn driving
// ---------------------------------------------------------------------------

async fn drive_turn(
    headless: &mut HeadlessLoop,
    provider: &OpenAiStepProvider,
    prompt: Option<&str>,
    session_id: &str,
    shutdown_grace_ms: u64,
) -> i32 {
    let token = headless.cancellation_token();
    let signal_code = Arc::new(AtomicI32::new(0));
    let notify = Arc::new(Notify::new());
    spawn_signal_task(token, signal_code.clone(), notify.clone());

    let mut sink = StdoutSink::default();
    let grace = Duration::from_millis(shutdown_grace_ms);
    let outcome = tokio::select! {
        result = async {
            match prompt {
                Some(text) => headless.run_turn_with_sink(text, provider, &mut sink).await,
                None => headless.continue_turn_with_sink(provider, &mut sink).await,
            }
        } => Some(result),
        _ = wait_for_grace(&notify, grace) => None,
    };
    sink.finish();

    let signal_code = signal_code.load(Ordering::SeqCst);
    match outcome {
        // Grace expired while cancelling: leave the attempt for later resume.
        None => {
            if signal_code != 0 {
                signal_code
            } else {
                130
            }
        }
        Some(result) => finish_report(result, headless, session_id, signal_code),
    }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async fn run_command(args: RunArgs) -> i32 {
    let env_vars: HashMap<String, String> = std::env::vars().collect();
    let cwd = workspace_dir();

    let overrides = ConfigCliOverrides {
        provider: args.provider.clone(),
        protocol: args.protocol.clone(),
        model: args.model.clone(),
        context_window: args
            .context_window
            .as_deref()
            .map(|value| parse_number("--context-window", value)),
        reasoning: args.reasoning.clone(),
        max_output_tokens: args
            .max_output_tokens
            .as_deref()
            .map(|value| parse_number("--max-output-tokens", value)),
        max_steps: args
            .max_steps
            .as_deref()
            .map(|value| parse_number("--max-steps", value)),
        incognito: args.incognito,
        debug: args.debug,
    };

    let loader_env = loader_env(&env_vars, &cwd);
    let (config, _digest, _warnings) = match load_effective_config(
        args.config.as_deref().map(Path::new),
        &overrides,
        &loader_env,
    ) {
        Ok(triple) => triple,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };
    let praana_home = match normalize_praana_home(
        env_vars.get("PRAANA_HOME").map(String::as_str),
        &loader_env.home_dir,
        &cwd,
    ) {
        Ok(path) => path,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };

    if cfg!(windows) {
        eprintln!("error: headless session creation is fail-closed on Windows");
        return 1;
    }

    let provider = match OpenAiStepProvider::new(&config, &praana_home, &cwd) {
        Ok(provider) => provider,
        Err(err) => {
            eprintln!("{}", turn_error_text(&err));
            return 2;
        }
    };

    let ids = MonotonicUlidGenerator::system();
    let session_id = match ids.next_id::<SessionId>() {
        Ok(id) => id,
        Err(err) => {
            eprintln!("error: {err}");
            return 2;
        }
    };
    let session_dir = PathBuf::from(&config.session.root).join(session_id.to_string());
    let loop_config = LoopConfig {
        session_dir,
        workspace: cwd,
        config: config.clone(),
        clock: Arc::new(SystemClock),
        ids: Arc::new(ids),
        fault: LoopFault::None,
    };
    let mut headless = match HeadlessLoop::create(loop_config) {
        Ok(headless) => headless,
        Err(err) => {
            eprintln!("error: {}", turn_error_text(&err));
            return 2;
        }
    };

    let session_id = session_id.to_string();
    drive_turn(
        &mut headless,
        &provider,
        Some(&args.prompt),
        &session_id,
        config.session.shutdown_grace_ms,
    )
    .await
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

fn selector_prefix(token: &str) -> Option<String> {
    if token.len() == 12 {
        return ResumeSelector::from_canonical_str(token)
            .ok()
            .map(|selector| selector.0);
    }
    if token.len() == 26 && SessionId::from_str_canonical(token).is_ok() {
        return Some(token[..12].to_owned());
    }
    None
}

fn find_session(root: &Path, prefix: &str) -> Result<Vec<(PathBuf, String)>, i32> {
    let mut matches: Vec<(PathBuf, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path.join("meta.json")) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim_end_matches('\n'))
            else {
                continue;
            };
            let Some(id) = value.get("session_id").and_then(|field| field.as_str()) else {
                continue;
            };
            if id.starts_with(prefix) {
                matches.push((path, id.to_owned()));
            }
        }
    }
    matches.sort_by(|left, right| left.1.cmp(&right.1));
    match matches.len() {
        0 => {
            eprintln!("SessionNotFound: no session matches selector {prefix}");
            Err(2)
        }
        1 => Ok(matches),
        count => {
            eprintln!("ResumeSelectorAmbiguous: selector {prefix} matches {count} sessions");
            for (_, id) in &matches {
                eprintln!("{id}");
            }
            Err(2)
        }
    }
}

async fn resume_command(args: ResumeArgs) -> i32 {
    let env_vars: HashMap<String, String> = std::env::vars().collect();
    let cwd = workspace_dir();

    let overrides = ConfigCliOverrides {
        debug: args.debug,
        ..ConfigCliOverrides::default()
    };
    let loader_env = loader_env(&env_vars, &cwd);
    let (config, loaded_digest, _warnings) = match load_effective_config(
        args.config.as_deref().map(Path::new),
        &overrides,
        &loader_env,
    ) {
        Ok(triple) => triple,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };
    let praana_home = match normalize_praana_home(
        env_vars.get("PRAANA_HOME").map(String::as_str),
        &loader_env.home_dir,
        &cwd,
    ) {
        Ok(path) => path,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };

    let Some(prefix) = selector_prefix(&args.selector) else {
        eprintln!("invalid resume selector: {}", args.selector);
        return 2;
    };
    let root = PathBuf::from(&config.session.root);
    let mut found = match find_session(&root, &prefix) {
        Ok(found) => found,
        Err(code) => return code,
    };

    if cfg!(windows) {
        eprintln!("error: headless resume is fail-closed on Windows");
        return 1;
    }

    let (session_dir, session_id) = found.remove(0);
    let meta_text = std::fs::read_to_string(session_dir.join("meta.json")).unwrap_or_default();
    let meta: serde_json::Value = match serde_json::from_str(meta_text.trim_end_matches('\n')) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("CONFIG_SNAPSHOT_MISMATCH: unreadable session manifest");
            return 2;
        }
    };
    let Some(meta_digest) = meta
        .get("config_digest_sha256")
        .and_then(|field| field.as_str())
    else {
        eprintln!("CONFIG_SNAPSHOT_MISMATCH: manifest lacks a config digest");
        return 2;
    };
    let workspace = meta
        .get("cwd")
        .and_then(|field| field.as_str())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| cwd.clone());

    let snapshot_text = match std::fs::read_to_string(session_dir.join("config.snapshot.json")) {
        Ok(text) => text,
        Err(_) => {
            eprintln!("CONFIG_SNAPSHOT_MISMATCH: missing creation snapshot");
            return 2;
        }
    };
    let creation_config: EffectiveConfigV1 =
        match serde_json::from_str(snapshot_text.trim_end_matches('\n')) {
            Ok(config) => config,
            Err(err) => {
                eprintln!("CONFIG_SNAPSHOT_MISMATCH: unreadable creation snapshot: {err}");
                return 2;
            }
        };
    let creation_digest = creation_config.config_digest_sha256();
    if creation_digest.0 != meta_digest {
        eprintln!("CONFIG_SNAPSHOT_MISMATCH: snapshot digest differs from the manifest");
        return 2;
    }

    let resume_config =
        match resolve_resume_config(&creation_config, &creation_digest, &config, &loaded_digest) {
            Ok(result) => result,
            Err(err) => {
                eprintln!("{err}");
                return 2;
            }
        };
    if resume_config.changed_since_create {
        eprintln!(
            "warning: configuration changed since create: {}",
            resume_config.changed_keys.join(", ")
        );
    }

    let runtime_config = resume_config.runtime_config;
    let provider = match OpenAiStepProvider::new(&runtime_config, &praana_home, &workspace) {
        Ok(provider) => provider,
        Err(err) => {
            eprintln!("{}", turn_error_text(&err));
            return 2;
        }
    };

    let loop_config = LoopConfig {
        session_dir,
        workspace,
        config: runtime_config.clone(),
        clock: Arc::new(SystemClock),
        ids: Arc::new(MonotonicUlidGenerator::system()),
        fault: LoopFault::None,
    };
    let mut headless = match HeadlessLoop::resume(loop_config) {
        Ok(headless) => headless,
        Err(err) => {
            eprintln!("error: {}", turn_error_text(&err));
            return 1;
        }
    };

    match headless.has_active_turn() {
        Ok(true) => {
            drive_turn(
                &mut headless,
                &provider,
                None,
                &session_id,
                runtime_config.session.shutdown_grace_ms,
            )
            .await
        }
        Ok(false) => {
            print_resume_id(&session_id);
            0
        }
        Err(err) => {
            eprintln!("error: {}", turn_error_text(&err));
            1
        }
    }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let args: Vec<String> = match std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string())
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(args) => args,
        Err(_) => usage_exit(),
    };
    let code = match parse(&args) {
        Invocation::Help(text) => print_help(text),
        Invocation::Version => print_version(),
        Invocation::Run(args) => run_command(args).await,
        Invocation::Resume(args) => resume_command(args).await,
    };
    std::process::exit(code);
}
