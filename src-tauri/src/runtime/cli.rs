use crate::runtime::{
    gateway::{MinimalRuntimeGateway, RuntimeEventSink},
    RunCancelRequest, RunStartRequest, RuntimeError, RuntimeEvent, RuntimeEventEnvelope,
    RuntimeStatus, SessionCreateRequest,
};
use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, IsTerminal, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

const EXIT_SUCCESS: i32 = 0;
const EXIT_RUNTIME_ERROR: i32 = 1;
const EXIT_INTERRUPTED: i32 = 130;
pub const CLI_HANDOFF_ENV: &str = "BIBIT_CLI_HANDOFF";

#[derive(Debug, Parser)]
#[command(name = "bibit", about = "BiBit Agent Runtime 命令行入口")]
struct CliArgs {
    /// 保留旧 CLI 参数；Agent Runtime 始终使用流式事件。
    #[arg(long, value_enum, default_value_t = CliMode::Streaming)]
    mode: CliMode,
    #[arg(value_name = "PROMPT")]
    prompt: Vec<String>,
    /// 新会话绑定的 Agent；省略时按可用性自动选择。
    #[arg(long, value_name = "AGENT_ID")]
    agent: Option<String>,
    /// 恢复显式 Runtime 目标下的现有 Session。
    #[arg(long, requires_all = ["target_id", "runtime_epoch"])]
    session_id: Option<String>,
    /// Session 所属的 Runtime 目标身份。
    #[arg(long, requires_all = ["session_id", "runtime_epoch"])]
    target_id: Option<String>,
    /// 捕获 Session 时的 Runtime epoch。
    #[arg(long, requires_all = ["session_id", "target_id"])]
    runtime_epoch: Option<String>,
    /// GUI 交接文件；由 Bibit 创建并在 CLI 读取后删除。
    #[arg(long, hide = true, conflicts_with_all = ["session_id", "target_id", "runtime_epoch"])]
    handoff: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum CliMode {
    Fixed,
    Streaming,
}

#[derive(Clone)]
pub struct CliRuntimeEventSink {
    events: mpsc::UnboundedSender<RuntimeEventEnvelope>,
}

impl CliRuntimeEventSink {
    pub fn new(events: mpsc::UnboundedSender<RuntimeEventEnvelope>) -> Self {
        Self { events }
    }
}

impl RuntimeEventSink for CliRuntimeEventSink {
    fn emit(&self, event: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
        self.events.send(event.clone()).map_err(|_| {
            RuntimeError::new(
                crate::runtime::RuntimeErrorCode::InternalError,
                "CLI event stream closed",
            )
        })
    }
}

fn runtime_data_root() -> PathBuf {
    let data_dir = dirs::data_dir().unwrap_or_else(|| {
        PathBuf::from(
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_default(),
        )
    });
    let config_path = data_dir.join("BiBit").join("settings.json");
    runtime_data_root_from_paths(
        std::env::var("JAN_DATA_FOLDER").ok(),
        &config_path,
        &data_dir,
    )
}

fn runtime_data_root_from_paths(
    env_override: Option<String>,
    config_path: &Path,
    data_dir: &Path,
) -> PathBuf {
    if let Some(folder) = env_override.filter(|folder| !folder.is_empty()) {
        return PathBuf::from(folder);
    }
    if let Ok(content) = std::fs::read_to_string(config_path) {
        if let Ok(config) = serde_json::from_str::<CliConfiguration>(&content) {
            if !config.data_folder.is_empty() {
                return PathBuf::from(config.data_folder);
            }
        }
    }
    data_dir.join("BiBit").join("data")
}

fn prompt_from_piped_input(input: &str) -> Option<String> {
    let prompt = input.trim();
    (!prompt.is_empty()).then(|| prompt.to_owned())
}

#[derive(Debug, PartialEq, Eq)]
enum InteractiveInput {
    Eof,
    Exit,
    Empty,
    Prompt(String),
}

fn read_interactive_input(reader: &mut impl BufRead) -> io::Result<InteractiveInput> {
    let mut input = String::new();
    match reader.read_line(&mut input)? {
        0 => Ok(InteractiveInput::Eof),
        _ if input.trim() == "/exit" => Ok(InteractiveInput::Exit),
        _ if input.trim().is_empty() => Ok(InteractiveInput::Empty),
        _ => Ok(InteractiveInput::Prompt(input.trim().to_owned())),
    }
}

#[derive(Debug, Deserialize)]
struct CliConfiguration {
    data_folder: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CliHandoff {
    target_id: String,
    runtime_epoch: String,
    session_id: String,
    draft: String,
}

fn parse_args<I, S>(args: I, output: &mut impl Write) -> Result<CliArgs, i32>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString> + Clone,
{
    CliArgs::try_parse_from(args).map_err(|parse_error| {
        let exit_code = parse_error.exit_code();
        let _ = write!(output, "{parse_error}");
        let _ = output.flush();
        exit_code
    })
}

fn read_handoff(path: &Path) -> Result<CliHandoff, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("无法读取 CLI 交接信息: {error}"))?;
    let _ = std::fs::remove_file(path);
    serde_json::from_slice(&bytes).map_err(|error| format!("CLI 交接信息无效: {error}"))
}

fn explicit_handoff(
    args: &CliArgs,
    inherited_path: Option<PathBuf>,
) -> Result<Option<CliHandoff>, String> {
    if let Some(path) = args.handoff.as_deref().or(inherited_path.as_deref()) {
        return read_handoff(path).map(Some);
    }
    match (
        args.target_id.as_deref(),
        args.runtime_epoch.as_deref(),
        args.session_id.as_deref(),
    ) {
        (Some(target_id), Some(runtime_epoch), Some(session_id)) => Ok(Some(CliHandoff {
            target_id: target_id.to_owned(),
            runtime_epoch: runtime_epoch.to_owned(),
            session_id: session_id.to_owned(),
            draft: String::new(),
        })),
        (None, None, None) => Ok(None),
        _ => Err("恢复 Session 必须同时提供 target-id、runtime-epoch 和 session-id".into()),
    }
}

fn validate_handoff(
    handoff: &CliHandoff,
    target_id: &str,
    runtime_epoch: Option<&str>,
    sessions: &[crate::runtime::RuntimeSession],
) -> Result<(), String> {
    if handoff.target_id != target_id {
        return Err("Runtime 目标不匹配，拒绝恢复 Session".into());
    }
    if Some(handoff.runtime_epoch.as_str()) != runtime_epoch {
        return Err("Runtime epoch 已过期，拒绝恢复 Session".into());
    }
    if !sessions
        .iter()
        .any(|session| session.id == handoff.session_id)
    {
        return Err("指定 Session 不存在，拒绝恢复".into());
    }
    Ok(())
}

fn validate_gui_handoff(
    handoff: &CliHandoff,
    target_id: &str,
    sessions: &[crate::runtime::RuntimeSession],
) -> Result<(), String> {
    if handoff.target_id != target_id {
        return Err("Runtime 目标不匹配，拒绝恢复 Session".into());
    }
    if !sessions
        .iter()
        .any(|session| session.id == handoff.session_id)
    {
        return Err("指定 Session 不存在，拒绝恢复".into());
    }
    Ok(())
}

/// 新建会话要绑定的 Agent：显式指定优先，否则按可用性解析。
fn resolve_agent(
    agents: &[crate::runtime::RuntimeAgent],
    requested: Option<&str>,
) -> Result<String, String> {
    if let Some(requested) = requested.map(str::trim).filter(|id| !id.is_empty()) {
        return match agents.iter().find(|agent| agent.id == requested) {
            Some(agent) if agent.available => Ok(agent.id.clone()),
            Some(_) => Err(format!(
                "Agent {requested} 当前不可用，无法创建会话。{}",
                agent_candidates(agents)
            )),
            None => Err(format!(
                "Runtime 中没有 Agent {requested}。{}",
                agent_candidates(agents)
            )),
        };
    }

    let available = agents
        .iter()
        .filter(|agent| agent.available)
        .collect::<Vec<_>>();
    match available.as_slice() {
        [] => Err(format!(
            "Runtime 当前没有可用的 Agent。{}",
            agent_candidates(agents)
        )),
        [only] => Ok(only.id.clone()),
        // 多个可用项时只有内置助手是稳定的默认选择；否则交给用户显式指定。
        several => match several.iter().find(|agent| agent.origin == "system") {
            Some(builtin) => Ok(builtin.id.clone()),
            None => Err(format!(
                "存在多个可用 Agent，请用 --agent 指定其中一个。{}",
                agent_candidates(agents)
            )),
        },
    }
}

/// 失败诊断用的候选清单：可用项给出 id 与名称，不可用项附带原因。
fn agent_candidates(agents: &[crate::runtime::RuntimeAgent]) -> String {
    if agents.is_empty() {
        return "候选：Runtime 未返回任何 Agent。".to_owned();
    }
    let lines = agents
        .iter()
        .map(|agent| {
            let name = if agent.zh_name.trim().is_empty() {
                agent.name.trim()
            } else {
                agent.zh_name.trim()
            };
            if agent.available {
                format!("  {}（{}）", agent.id, name)
            } else if agent.unavailable_reason.trim().is_empty() {
                format!("  {}（{}，不可用）", agent.id, name)
            } else {
                format!(
                    "  {}（{}，不可用：{}）",
                    agent.id,
                    name,
                    agent.unavailable_reason.trim()
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("候选：\n{lines}")
}

/// 每次命令行运行使用新的会话标识，避免复用既有会话的历史。
fn new_cli_session_id() -> String {
    format!("cli-{}", uuid::Uuid::new_v4().simple())
}

fn cli_handoff_path() -> Result<PathBuf, RuntimeError> {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/run/user").join(unsafe { libc::geteuid() }.to_string()));
    let directory = runtime_dir.join("bibit/runtime/handoffs");
    std::fs::create_dir_all(&directory).map_err(|error| {
        RuntimeError::new(
            crate::runtime::RuntimeErrorCode::InternalError,
            format!("无法创建 CLI 交接目录: {error}"),
        )
    })?;
    #[cfg(unix)]
    std::fs::set_permissions(
        &directory,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .map_err(|error| {
        RuntimeError::new(
            crate::runtime::RuntimeErrorCode::InternalError,
            format!("无法保护 CLI 交接目录: {error}"),
        )
    })?;
    Ok(directory.join(format!("{}.json", uuid::Uuid::new_v4())))
}

fn write_handoff(handoff: &CliHandoff) -> Result<PathBuf, RuntimeError> {
    let path = cli_handoff_path()?;
    let bytes = serde_json::to_vec(handoff).map_err(|error| {
        RuntimeError::new(
            crate::runtime::RuntimeErrorCode::InternalError,
            format!("无法编码 CLI 交接信息: {error}"),
        )
    })?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).map_err(|error| {
        RuntimeError::new(
            crate::runtime::RuntimeErrorCode::InternalError,
            format!("无法保存 CLI 交接信息: {error}"),
        )
    })?;
    file.write_all(&bytes).map_err(|error| {
        RuntimeError::new(
            crate::runtime::RuntimeErrorCode::InternalError,
            format!("无法写入 CLI 交接信息: {error}"),
        )
    })?;
    Ok(path)
}

fn terminal_program() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("BIBIT_TERMINAL").map(PathBuf::from) {
        return configured.is_file().then_some(configured);
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|directory| {
            ["x-terminal-emulator", "lxterminal", "gnome-terminal"]
                .map(move |name| directory.join(name))
        })
        .find(|candidate| candidate.is_file())
}

#[tauri::command]
pub async fn runtime_cli_handoff(
    window: WebviewWindow,
    manager: State<'_, Arc<crate::runtime::manager::RuntimeManager>>,
    controller: State<'_, crate::runtime::controller::ControllerLeaseManager>,
    session_id: String,
    target_id: String,
    runtime_epoch: String,
    draft: String,
) -> Result<u32, RuntimeError> {
    let gateway = manager.active_gateway().await?;
    let snapshot = gateway.snapshot().await;
    let sessions = gateway.list_sessions().await?;
    let handoff = CliHandoff {
        target_id,
        runtime_epoch,
        session_id,
        draft,
    };
    validate_handoff(
        &handoff,
        &gateway.target_id(),
        snapshot.runtime_epoch.as_deref(),
        &sessions,
    )
    .map_err(|message| {
        RuntimeError::new(crate::runtime::RuntimeErrorCode::SessionConflict, message)
    })?;

    let executable = std::env::current_exe().map_err(|error| {
        RuntimeError::new(
            crate::runtime::RuntimeErrorCode::InternalError,
            format!("无法定位 Bibit CLI: {error}"),
        )
    })?;
    let terminal = terminal_program().ok_or_else(|| {
        RuntimeError::new(
            crate::runtime::RuntimeErrorCode::InternalError,
            "没有可用的终端程序",
        )
    })?;
    let acquired = controller.acquire_for(Path::new(""), window.label())?;
    let path = match write_handoff(&handoff) {
        Ok(path) => path,
        Err(error) => {
            if acquired {
                let _ = controller.release_for(window.label());
            }
            return Err(error);
        }
    };
    if let Err(error) = gateway.detach_session(&handoff.session_id).await {
        let _ = std::fs::remove_file(&path);
        if acquired {
            let _ = controller.release_for(window.label());
        }
        return Err(error);
    }
    controller.release_all()?;
    let mut terminal_command = Command::new(terminal);
    if let Some(home) = dirs::home_dir() {
        terminal_command.current_dir(home);
    }
    match terminal_command
        .env(CLI_HANDOFF_ENV, &path)
        .arg("-e")
        .arg(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => Ok(child.id()),
        Err(error) => {
            let _ = std::fs::remove_file(path);
            let _ = controller.acquire_for(Path::new(""), window.label());
            Err(RuntimeError::new(
                crate::runtime::RuntimeErrorCode::InternalError,
                format!("无法启动 CLI: {error}"),
            ))
        }
    }
}

fn render_runtime_event(
    event: &RuntimeEvent,
    output: &mut impl Write,
    error: &mut impl Write,
) -> io::Result<()> {
    match event {
        RuntimeEvent::TextDelta { delta, .. } | RuntimeEvent::ReasoningDelta { delta, .. } => {
            output.write_all(delta.as_bytes())?;
            output.flush()
        }
        RuntimeEvent::RunCompleted { .. } => writeln!(output),
        RuntimeEvent::RunCancelled { .. } => writeln!(output, "\n已停止"),
        RuntimeEvent::RunFailed {
            error: runtime_error,
        } => {
            writeln!(
                error,
                "错误 [{}]：{}",
                runtime_error.code.code_as_str(),
                runtime_error.message
            )
        }
        _ => Ok(()),
    }
}

async fn execute_prompt(
    gateway: &Arc<MinimalRuntimeGateway>,
    events: &mut mpsc::UnboundedReceiver<RuntimeEventEnvelope>,
    session_id: &str,
    prompt: &str,
    output: &mut impl Write,
    error: &mut impl Write,
) -> i32 {
    let run = match gateway
        .start_run(RunStartRequest {
            session_id: session_id.into(),
            user_message_id: uuid::Uuid::new_v4().to_string(),
            prompt: prompt.into(),
        })
        .await
    {
        Ok(run) => run,
        Err(runtime_error) => {
            let _ = writeln!(
                error,
                "错误 [{}]：{}",
                runtime_error.code.code_as_str(),
                runtime_error.message
            );
            return EXIT_RUNTIME_ERROR;
        }
    };

    loop {
        let envelope = tokio::select! {
            envelope = events.recv() => envelope,
            interrupt = tokio::signal::ctrl_c() => {
                if interrupt.is_err() {
                    let _ = writeln!(error, "错误：无法监听 Ctrl-C");
                    return EXIT_RUNTIME_ERROR;
                }
                if let Err(runtime_error) = gateway
                    .cancel_run(RunCancelRequest {
                        session_id: session_id.into(),
                        run_id: run.run_id.clone(),
                    })
                    .await
                {
                    let _ = writeln!(
                        error,
                        "错误 [{}]：{}",
                        runtime_error.code.code_as_str(),
                        runtime_error.message
                    );
                    return EXIT_RUNTIME_ERROR;
                }
                continue;
            }
        };
        let Some(envelope) = envelope else { break };
        if envelope.run_id.as_deref() != Some(run.run_id.as_str()) {
            continue;
        }
        match &envelope.event {
            RuntimeEvent::RunCompleted { .. }
            | RuntimeEvent::RunCancelled { .. }
            | RuntimeEvent::RunFailed { .. } => {
                if let Err(io_error) = render_runtime_event(&envelope.event, output, error) {
                    let _ = writeln!(error, "错误：{io_error}");
                    return EXIT_RUNTIME_ERROR;
                }
                return if matches!(envelope.event, RuntimeEvent::RunCancelled { .. }) {
                    EXIT_INTERRUPTED
                } else if matches!(envelope.event, RuntimeEvent::RunFailed { .. }) {
                    EXIT_RUNTIME_ERROR
                } else {
                    EXIT_SUCCESS
                };
            }
            _ => {
                if let Err(io_error) = render_runtime_event(&envelope.event, output, error) {
                    let _ = writeln!(error, "错误：{io_error}");
                    return EXIT_RUNTIME_ERROR;
                }
            }
        }
    }
    let _ = writeln!(error, "错误：Agent Runtime 事件流意外结束");
    EXIT_RUNTIME_ERROR
}

pub fn run_cli_from_env() -> i32 {
    let mut args = std::env::args_os().collect::<Vec<_>>();
    if args.get(1).and_then(|arg| arg.to_str()) == Some("--cli") {
        args.remove(1);
    }
    let mut error = io::stderr();
    let parsed = match parse_args(args, &mut error) {
        Ok(args) => args,
        Err(exit_code) => return exit_code,
    };
    let inherited_handoff = std::env::var_os(CLI_HANDOFF_ENV).map(PathBuf::from);
    std::env::remove_var(CLI_HANDOFF_ENV);
    let gui_handoff = parsed.handoff.is_some() || inherited_handoff.is_some();
    let handoff = match explicit_handoff(&parsed, inherited_handoff) {
        Ok(handoff) => handoff,
        Err(message) => {
            let _ = writeln!(error, "错误：{message}");
            return EXIT_RUNTIME_ERROR;
        }
    };
    let mut output = io::stdout();
    let data_root = runtime_data_root();
    let runtime_cwd = match crate::runtime::cwd::resolve_runtime_cwd(&data_root) {
        Ok(path) => path,
        Err(runtime_error) => {
            let _ = writeln!(
                error,
                "错误 [{}]：{}",
                runtime_error.code.code_as_str(),
                runtime_error.message
            );
            return EXIT_RUNTIME_ERROR;
        }
    };
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let sink = Arc::new(CliRuntimeEventSink::new(event_tx));
    let gateway = match MinimalRuntimeGateway::production_default(runtime_cwd.clone(), sink) {
        Ok(gateway) => gateway,
        Err(runtime_error) => {
            let _ = writeln!(
                error,
                "错误 [{}]：{}",
                runtime_error.code.code_as_str(),
                runtime_error.message
            );
            return EXIT_RUNTIME_ERROR;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(runtime_error) => {
            let _ = writeln!(error, "错误：{runtime_error}");
            return EXIT_RUNTIME_ERROR;
        }
    };
    runtime.block_on(async {
        let _controller = match crate::runtime::controller::ControllerLease::acquire(&data_root) {
            Ok(lease) => lease,
            Err(runtime_error) => {
                let _ = writeln!(
                    error,
                    "错误 [{}]：{}",
                    runtime_error.code.code_as_str(),
                    runtime_error.message
                );
                return EXIT_RUNTIME_ERROR;
            }
        };
        let snapshot = match gateway.start().await {
            Ok(snapshot) if snapshot.status == RuntimeStatus::Ready => snapshot,
            Ok(snapshot) => {
                let _ = writeln!(error, "错误：Agent Runtime 状态为 {:?}", snapshot.status);
                return EXIT_RUNTIME_ERROR;
            }
            Err(runtime_error) => {
                let _ = writeln!(
                    error,
                    "错误 [{}]：{}",
                    runtime_error.code.code_as_str(),
                    runtime_error.message
                );
                return EXIT_RUNTIME_ERROR;
            }
        };
        let session_id: String = if let Some(handoff) = handoff.as_ref() {
            let sessions = match gateway.list_sessions().await {
                Ok(sessions) => sessions,
                Err(runtime_error) => {
                    let _ = writeln!(
                        error,
                        "错误 [{}]：{}",
                        runtime_error.code.code_as_str(),
                        runtime_error.message
                    );
                    let _ = gateway.stop().await;
                    return EXIT_RUNTIME_ERROR;
                }
            };
            let validation = if gui_handoff {
                // runtime_cli_handoff already checked the GUI epoch immediately
                // before creating this protected one-shot file. This CLI owns a
                // new Gateway and therefore has a different client epoch.
                validate_gui_handoff(handoff, &gateway.target_id(), &sessions)
            } else {
                validate_handoff(
                    handoff,
                    &gateway.target_id(),
                    snapshot.runtime_epoch.as_deref(),
                    &sessions,
                )
            };
            if let Err(message) = validation {
                let _ = writeln!(error, "错误：{message}");
                let _ = gateway.stop().await;
                return EXIT_RUNTIME_ERROR;
            }
            if let Err(runtime_error) = gateway.restore_session(&handoff.session_id).await {
                let _ = writeln!(
                    error,
                    "错误 [{}]：{}",
                    runtime_error.code.code_as_str(),
                    runtime_error.message
                );
                let _ = gateway.stop().await;
                return EXIT_RUNTIME_ERROR;
            }
            let _ = writeln!(output, "已恢复 Session {}", handoff.session_id);
            if parsed.agent.is_some() {
                let _ = writeln!(output, "--agent 仅用于新建会话，恢复既有会话时已忽略");
            }
            if !handoff.draft.is_empty() {
                let _ = writeln!(output, "未发送草稿：{}", handoff.draft);
            }
            handoff.session_id.clone()
        } else {
            let agents = match gateway.list_agents().await {
                Ok(agents) => agents,
                Err(runtime_error) => {
                    let _ = writeln!(
                        error,
                        "错误 [{}]：{}",
                        runtime_error.code.code_as_str(),
                        runtime_error.message
                    );
                    let _ = gateway.stop().await;
                    return EXIT_RUNTIME_ERROR;
                }
            };
            let agent_id = match resolve_agent(&agents, parsed.agent.as_deref()) {
                Ok(agent_id) => agent_id,
                Err(message) => {
                    let _ = writeln!(error, "错误：{message}");
                    let _ = gateway.stop().await;
                    return EXIT_RUNTIME_ERROR;
                }
            };
            let session_id = new_cli_session_id();
            if let Err(runtime_error) = gateway
                .create_session(
                    SessionCreateRequest {
                        agent_id: Some(agent_id),
                        session_id: session_id.clone(),
                        title: None,
                    },
                    runtime_cwd,
                )
                .await
            {
                let _ = writeln!(
                    error,
                    "错误 [{}]：{}",
                    runtime_error.code.code_as_str(),
                    runtime_error.message
                );
                let _ = gateway.stop().await;
                return EXIT_RUNTIME_ERROR;
            }
            session_id
        };

        if !parsed.prompt.is_empty() {
            let code = execute_prompt(
                &gateway,
                &mut event_rx,
                &session_id,
                &parsed.prompt.join(" "),
                &mut output,
                &mut error,
            )
            .await;
            let _ = gateway.stop().await;
            return code;
        }

        if !io::stdin().is_terminal() {
            let mut input = String::new();
            if let Err(io_error) = io::stdin().read_to_string(&mut input) {
                let _ = writeln!(error, "错误：{io_error}");
                let _ = gateway.stop().await;
                return EXIT_RUNTIME_ERROR;
            }
            let Some(prompt) = prompt_from_piped_input(&input) else {
                let _ = gateway.stop().await;
                return EXIT_SUCCESS;
            };
            let code = execute_prompt(
                &gateway,
                &mut event_rx,
                &session_id,
                &prompt,
                &mut output,
                &mut error,
            )
            .await;
            let _ = gateway.stop().await;
            return code;
        }

        loop {
            if write!(output, "bibit> ")
                .and_then(|_| output.flush())
                .is_err()
            {
                let _ = gateway.stop().await;
                return EXIT_RUNTIME_ERROR;
            }
            let input = tokio::task::spawn_blocking(|| {
                let stdin = io::stdin();
                read_interactive_input(&mut stdin.lock())
            })
            .await;
            let prompt = match input {
                Ok(Ok(InteractiveInput::Eof | InteractiveInput::Exit)) => {
                    let _ = gateway.stop().await;
                    return EXIT_SUCCESS;
                }
                Ok(Ok(InteractiveInput::Empty)) => continue,
                Ok(Ok(InteractiveInput::Prompt(prompt))) => prompt,
                Ok(Err(io_error)) => {
                    let _ = writeln!(error, "错误：无法读取标准输入：{io_error}");
                    let _ = gateway.stop().await;
                    return EXIT_RUNTIME_ERROR;
                }
                Err(join_error) => {
                    let _ = writeln!(error, "错误：无法读取标准输入：{join_error}");
                    let _ = gateway.stop().await;
                    return EXIT_RUNTIME_ERROR;
                }
            };
            let code = execute_prompt(
                &gateway,
                &mut event_rx,
                &session_id,
                &prompt,
                &mut output,
                &mut error,
            )
            .await;
            if code != EXIT_SUCCESS {
                let _ = gateway.stop().await;
                return code;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeError, RuntimeErrorCode, RuntimeEvent};
    use std::io::BufRead;

    struct FailingReader;

    fn session(id: &str) -> crate::runtime::RuntimeSession {
        crate::runtime::RuntimeSession {
            running: false,
            waiting: false,
            failed: false,
            completed_unread: false,
            active_run_id: None,
            pending_interaction: None,
            id: id.into(),
            title: "会话".into(),
            agent_id: "agent".into(),
            metadata: Default::default(),
            created_at: 1.0,
            updated_at: 1.0,
            latest_run: None,
        }
    }

    impl Read for FailingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "stdin denied",
            ))
        }
    }

    impl BufRead for FailingReader {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "stdin denied",
            ))
        }

        fn consume(&mut self, _amount: usize) {}
    }

    #[test]
    fn help_is_rendered_for_cli_users() {
        let mut output = Vec::new();
        let exit_code = parse_args(["bibit", "--help"], &mut output).unwrap_err();

        assert_eq!(exit_code, EXIT_SUCCESS);
        assert!(String::from_utf8(output)
            .unwrap()
            .contains("BiBit Agent Runtime 命令行入口"));
    }

    #[test]
    fn explicit_session_requires_complete_identity() {
        let mut output = Vec::new();
        assert!(parse_args(
            [
                "bibit",
                "--session-id",
                "session-a",
                "--target-id",
                "target-a",
                "--runtime-epoch",
                "epoch-a",
            ],
            &mut output,
        )
        .is_ok());
        assert!(parse_args(["bibit", "--session-id", "session-a"], &mut output,).is_err());
    }

    #[test]
    fn inherited_handoff_path_is_consumed_once() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("handoff.json");
        let expected = CliHandoff {
            target_id: "target-a".into(),
            runtime_epoch: "epoch-a".into(),
            session_id: "session-a".into(),
            draft: "草稿".into(),
        };
        std::fs::write(&path, serde_json::to_vec(&expected).unwrap()).unwrap();
        let args = parse_args(["bibit"], &mut Vec::new()).unwrap();

        assert_eq!(
            explicit_handoff(&args, Some(path.clone())).unwrap(),
            Some(expected)
        );
        assert!(!path.exists());
    }

    #[test]
    fn handoff_rejects_target_epoch_and_session_mismatch() {
        let handoff = CliHandoff {
            target_id: "target-a".into(),
            runtime_epoch: "epoch-a".into(),
            session_id: "session-a".into(),
            draft: "草稿".into(),
        };
        let sessions = vec![session("session-a")];
        assert!(validate_handoff(&handoff, "target-a", Some("epoch-a"), &sessions).is_ok());
        assert_eq!(
            validate_handoff(&handoff, "target-b", Some("epoch-a"), &sessions).unwrap_err(),
            "Runtime 目标不匹配，拒绝恢复 Session"
        );
        assert_eq!(
            validate_handoff(&handoff, "target-a", Some("epoch-b"), &sessions).unwrap_err(),
            "Runtime epoch 已过期，拒绝恢复 Session"
        );
        assert_eq!(
            validate_handoff(&handoff, "target-a", Some("epoch-a"), &[]).unwrap_err(),
            "指定 Session 不存在，拒绝恢复"
        );
    }

    #[test]
    fn gui_handoff_accepts_a_new_cli_gateway_epoch_but_rechecks_target_and_session() {
        let handoff = CliHandoff {
            target_id: "target-a".into(),
            runtime_epoch: "gui-epoch".into(),
            session_id: "session-a".into(),
            draft: "草稿".into(),
        };
        let sessions = vec![session("session-a")];

        assert!(validate_gui_handoff(&handoff, "target-a", &sessions).is_ok());
        assert_eq!(
            validate_gui_handoff(&handoff, "target-b", &sessions).unwrap_err(),
            "Runtime 目标不匹配，拒绝恢复 Session"
        );
        assert_eq!(
            validate_gui_handoff(&handoff, "target-a", &[]).unwrap_err(),
            "指定 Session 不存在，拒绝恢复"
        );
        assert_eq!(
            validate_handoff(&handoff, "target-a", Some("cli-epoch"), &sessions).unwrap_err(),
            "Runtime epoch 已过期，拒绝恢复 Session"
        );
    }

    #[test]
    fn configured_data_folder_is_preferred_when_env_override_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let configured = temp.path().join("configured-data");
        let config_path = temp.path().join("BiBit").join("settings.json");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::write(
            &config_path,
            serde_json::json!({"data_folder": configured}).to_string(),
        )
        .unwrap();

        assert_eq!(
            runtime_data_root_from_paths(None, &config_path, temp.path()),
            configured
        );
    }

    #[test]
    fn empty_piped_input_is_not_a_prompt() {
        assert_eq!(prompt_from_piped_input(" \n\t"), None);
        assert_eq!(prompt_from_piped_input(" 你好 \n"), Some("你好".to_owned()));
    }

    #[test]
    fn interactive_input_distinguishes_prompt_exit_and_eof() {
        assert_eq!(
            read_interactive_input(&mut io::Cursor::new("你好\n".as_bytes())).unwrap(),
            InteractiveInput::Prompt("你好".to_owned())
        );
        assert_eq!(
            read_interactive_input(&mut io::Cursor::new("/exit\n".as_bytes())).unwrap(),
            InteractiveInput::Exit
        );
        assert_eq!(
            read_interactive_input(&mut io::Cursor::new(Vec::<u8>::new())).unwrap(),
            InteractiveInput::Eof
        );
    }

    #[test]
    fn interactive_input_propagates_stdin_errors() {
        let error = read_interactive_input(&mut FailingReader).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), "stdin denied");
    }

    #[test]
    fn renders_formal_runtime_events_for_terminal_output() {
        let mut output = Vec::new();
        let mut error = Vec::new();
        render_runtime_event(
            &RuntimeEvent::TextDelta {
                message_id: "assistant-1".into(),
                delta: "你好".into(),
            },
            &mut output,
            &mut error,
        )
        .unwrap();
        render_runtime_event(
            &RuntimeEvent::RunCompleted {
                stop_reason: Some("end_turn".into()),
            },
            &mut output,
            &mut error,
        )
        .unwrap();

        assert_eq!(String::from_utf8(output).unwrap(), "你好\n");
        assert!(error.is_empty());
    }

    #[test]
    fn renders_structured_runtime_failure_to_error_output() {
        let mut output = Vec::new();
        let mut error = Vec::new();
        render_runtime_event(
            &RuntimeEvent::RunFailed {
                error: RuntimeError::new(RuntimeErrorCode::ProcessExited, "Hermes 已退出"),
            },
            &mut output,
            &mut error,
        )
        .unwrap();

        assert!(output.is_empty());
        assert_eq!(
            String::from_utf8(error).unwrap(),
            "错误 [process_exited]：Hermes 已退出\n"
        );
    }

    fn agent_fixture(id: &str, origin: &str, available: bool) -> crate::runtime::RuntimeAgent {
        crate::runtime::RuntimeAgent {
            id: id.into(),
            name: format!("{id}-name"),
            zh_name: String::new(),
            origin: origin.into(),
            model: None,
            available,
            unavailable_reason: if available {
                String::new()
            } else {
                "agent_model_required".into()
            },
            skills: Vec::new(),
            tools: Vec::new(),
            plugins: Vec::new(),
            mcps: Vec::new(),
        }
    }

    #[test]
    fn resolves_the_only_available_agent_without_a_flag() {
        let agents = [
            agent_fixture("agent-a", "user", false),
            agent_fixture("agent-b", "user", true),
        ];

        assert_eq!(resolve_agent(&agents, None).unwrap(), "agent-b");
    }

    #[test]
    fn prefers_the_builtin_agent_when_several_are_available() {
        let agents = [
            agent_fixture("agent-user", "user", true),
            agent_fixture("agent-builtin", "system", true),
        ];

        assert_eq!(resolve_agent(&agents, None).unwrap(), "agent-builtin");
    }

    #[test]
    fn asks_for_an_explicit_agent_when_no_builtin_is_available() {
        let agents = [
            agent_fixture("agent-a", "user", true),
            agent_fixture("agent-b", "user", true),
        ];

        let message = resolve_agent(&agents, None).unwrap_err();
        assert!(message.contains("--agent"), "{message}");
        assert!(message.contains("agent-a"), "{message}");
        assert!(message.contains("agent-b"), "{message}");
    }

    #[test]
    fn reports_candidates_with_reasons_when_nothing_is_available() {
        let agents = [agent_fixture("agent-a", "user", false)];
        let message = resolve_agent(&agents, None).unwrap_err();
        assert!(message.contains("没有可用"), "{message}");
        assert!(message.contains("agent-a"), "{message}");
        assert!(message.contains("agent_model_required"), "{message}");

        let empty: [crate::runtime::RuntimeAgent; 0] = [];
        let empty_message = resolve_agent(&empty, None).unwrap_err();
        assert!(empty_message.contains("未返回任何 Agent"), "{empty_message}");
    }

    #[test]
    fn honours_an_explicit_agent_and_rejects_unknown_or_unavailable_ones() {
        let agents = [
            agent_fixture("agent-a", "user", true),
            agent_fixture("agent-b", "user", false),
        ];

        assert_eq!(resolve_agent(&agents, Some("agent-a")).unwrap(), "agent-a");

        let unknown = resolve_agent(&agents, Some("agent-x")).unwrap_err();
        assert!(unknown.contains("agent-x"), "{unknown}");
        assert!(unknown.contains("agent-a"), "{unknown}");

        let unavailable = resolve_agent(&agents, Some("agent-b")).unwrap_err();
        assert!(unavailable.contains("agent-b"), "{unavailable}");
        assert!(unavailable.contains("不可用"), "{unavailable}");
    }

    #[test]
    fn every_run_uses_a_fresh_session_id() {
        let first = new_cli_session_id();
        let second = new_cli_session_id();

        assert_ne!(first, second);
        assert!(first.starts_with("cli-"), "{first}");
    }

    #[test]
    fn agent_flag_parses_with_and_without_session_restore() {
        let parsed = parse_args(["bibit", "--agent", "agent-a", "你好"], &mut Vec::new()).unwrap();
        assert_eq!(parsed.agent.as_deref(), Some("agent-a"));
        assert_eq!(parsed.prompt, vec!["你好".to_owned()]);

        // 恢复既有会话时 agent 标记不再生效，由交接信息决定绑定。
        let restore = parse_args(
            [
                "bibit",
                "--agent",
                "agent-a",
                "--session-id",
                "session-a",
                "--target-id",
                "target-a",
                "--runtime-epoch",
                "epoch-a",
            ],
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(restore.agent.as_deref(), Some("agent-a"));
        assert_eq!(restore.session_id.as_deref(), Some("session-a"));
    }
}
