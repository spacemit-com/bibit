use super::driver::{
    DriverEvent, DriverLifecycleEvent, DriverPermissionRequest, DriverPromptRequest, DriverStart,
    RuntimeDriver,
};
use super::{
    DiagnosticLevel, PermissionDecision, RuntimeError, RuntimeErrorCode, MAX_TOOL_VALUE_BYTES,
    PERMISSION_TIMEOUT_SECS,
};
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ContentChunk, Implementation, InitializeRequest, McpServer,
    McpServerStdio, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
    StopReason, ToolCall, ToolCallStatus,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{
    AcpAgent, ActiveSession, Agent, Client, ConnectionTo, Handled, LineDirection,
    RawJsonRpcMessage, SessionMessage, UntypedMessage,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};

const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(feature = "runtime-test-agent")]
const SESSION_CREATE_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(not(feature = "runtime-test-agent"))]
const SESSION_CREATE_TIMEOUT: Duration = Duration::from_secs(15);
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(PERMISSION_TIMEOUT_SECS);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(feature = "runtime-test-agent")]
const PROMPT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(not(feature = "runtime-test-agent"))]
const PROMPT_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
const STDERR_LIMIT: usize = 64 * 1024;
pub const PROCESS_LAUNCHER_ARG: &str = "--runtime-agent-launcher";
const KNOWN_SESSION_UPDATES: &[&str] = &[
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "available_commands_update",
    "current_mode_update",
    "config_option_update",
    "session_info_update",
    "usage_update",
];

#[derive(Clone, Debug)]
pub struct HermesProcessSpec {
    pub command: PathBuf,
    pub check_args: Vec<String>,
    pub run_args: Vec<String>,
    pub process_launcher: Option<PathBuf>,
}

impl Default for HermesProcessSpec {
    fn default() -> Self {
        Self {
            command: default_hermes_command(),
            check_args: vec!["acp".into(), "--help".into()],
            run_args: vec!["acp".into()],
            process_launcher: None,
        }
    }
}

fn default_hermes_command() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local").join("bin").join("hermes"))
        .filter(|command| command.is_file())
        .unwrap_or_else(|| PathBuf::from("hermes"))
}

impl HermesProcessSpec {
    #[cfg(feature = "runtime-test-agent")]
    pub fn for_test(scenario: &str) -> Self {
        let executable = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent()?.parent().map(PathBuf::from))
            .map(|path| path.join(format!("bibit-gui{}", std::env::consts::EXE_SUFFIX)))
            .unwrap_or_else(|| PathBuf::from("bibit-gui"));
        Self {
            command: executable.clone(),
            check_args: vec!["--runtime-test-agent".into(), "--check".into()],
            run_args: vec![
                "--runtime-test-agent".into(),
                "--scenario".into(),
                scenario.into(),
            ],
            process_launcher: Some(executable),
        }
    }
}

pub struct HermesAcpDriver {
    spec: HermesProcessSpec,
    runtime_cwd: Option<PathBuf>,
    control: Arc<Mutex<Option<ActorControl>>>,
    session_cwds: Arc<Mutex<HashMap<String, PathBuf>>>,
}

struct ActorControl {
    state: Arc<ActorState>,
    commands: mpsc::UnboundedSender<ActorCommand>,
    task: JoinHandle<()>,
}

enum ActorCommand {
    CreateSession {
        cwd: PathBuf,
        response: oneshot::Sender<Result<String, RuntimeError>>,
    },
    Prompt {
        request: DriverPromptRequest,
        events: mpsc::UnboundedSender<DriverEvent>,
        response: oneshot::Sender<Result<(), RuntimeError>>,
    },
    Cancel {
        session_id: String,
        run_id: String,
        response: oneshot::Sender<Result<(), RuntimeError>>,
    },
    ResolvePermission {
        request_id: String,
        decision: PermissionDecision,
        response: oneshot::Sender<Result<(), RuntimeError>>,
    },
    CancelPermission {
        request_id: String,
        response: oneshot::Sender<Result<(), RuntimeError>>,
    },
    Stop(oneshot::Sender<()>),
}

struct ActiveRun {
    run_id: String,
    events: mpsc::UnboundedSender<DriverEvent>,
}

enum BrokerDecision {
    Resolve(PermissionDecision),
    Cancelled,
}

struct PendingPermission {
    session_id: String,
    decision: oneshot::Sender<BrokerDecision>,
}

#[derive(Default)]
struct ActorState {
    active_runs: Mutex<HashMap<String, ActiveRun>>,
    permissions: Mutex<HashMap<String, PendingPermission>>,
    polluted_stdout: AtomicBool,
    saw_error_response: AtomicBool,
    initialize_attempted: AtomicBool,
    initialized: AtomicBool,
    unknown_updates: StdMutex<HashMap<String, usize>>,
    stopping: AtomicBool,
    stderr_tail: StdMutex<VecDeque<u8>>,
}

impl HermesAcpDriver {
    pub fn production(runtime_cwd: PathBuf) -> Self {
        Self::new_with_runtime_cwd(HermesProcessSpec::default(), runtime_cwd)
    }

    pub fn new(spec: HermesProcessSpec) -> Self {
        Self {
            spec,
            runtime_cwd: None,
            control: Arc::new(Mutex::new(None)),
            session_cwds: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn new_with_runtime_cwd(spec: HermesProcessSpec, runtime_cwd: PathBuf) -> Self {
        Self {
            spec,
            runtime_cwd: Some(runtime_cwd),
            control: Arc::new(Mutex::new(None)),
            session_cwds: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn command<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<T, RuntimeError>>) -> ActorCommand,
    ) -> Result<T, RuntimeError> {
        let (sender, receiver) = oneshot::channel();
        let commands = self
            .control
            .lock()
            .await
            .as_ref()
            .map(|control| control.commands.clone())
            .ok_or_else(stopped_error)?;
        commands.send(build(sender)).map_err(|_| process_error())?;
        receiver.await.map_err(|_| process_error())?
    }
}

#[async_trait]
impl RuntimeDriver for HermesAcpDriver {
    async fn check(&self) -> Result<(), RuntimeError> {
        run_preflight(
            self.spec.command.clone(),
            self.spec.check_args.clone(),
            self.runtime_cwd.as_deref(),
            CHECK_TIMEOUT,
        )
        .await
    }

    async fn start(&self) -> Result<DriverStart, RuntimeError> {
        if self.control.lock().await.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::HermesStartFailed,
                "Hermes is already started",
            ));
        }

        let state = Arc::new(ActorState::default());
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let (lifecycle_tx, lifecycle_rx) = mpsc::unbounded_channel();
        let (startup_tx, mut startup_rx) = mpsc::unbounded_channel();
        let agent = build_agent(&self.spec, self.runtime_cwd.as_deref(), state.clone())?;
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            let permission_state = task_state.clone();
            let extension_state = task_state.clone();
            let actor_startup_tx = startup_tx.clone();
            let result = Client
                .builder()
                .name("BiBit")
                .on_receive_request(
                    move |request: RequestPermissionRequest, responder, _connection| {
                        permission_handler(request, responder, permission_state.clone())
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_notification(
                    move |notification: UntypedMessage, connection| {
                        protocol_notification_handler(
                            notification,
                            connection,
                            extension_state.clone(),
                        )
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .connect_with(agent, |connection| {
                    connection_actor(
                        connection,
                        commands_rx,
                        task_state.clone(),
                        actor_startup_tx,
                    )
                })
                .await;

            let classified = if task_state.initialize_attempted.load(Ordering::Acquire)
                && !task_state.initialized.load(Ordering::Acquire)
            {
                classify_initialize_error(&task_state)
            } else {
                classify_connection_error(&task_state, result.as_ref().err())
            };
            if task_state.initialized.load(Ordering::Acquire) {
                if !task_state.stopping.load(Ordering::Acquire) {
                    let _ =
                        lifecycle_tx.send(DriverLifecycleEvent::ProcessExited(classified.clone()));
                    fail_active_runs(&task_state, classified).await;
                }
            } else {
                let _ = startup_tx.send(Err(classified));
            }
        });
        *self.control.lock().await = Some(ActorControl {
            state,
            commands: commands_tx,
            task,
        });

        let initialized = timeout(INITIALIZE_TIMEOUT, startup_rx.recv()).await;
        match initialized {
            Ok(Some(Ok(()))) => Ok(DriverStart {
                lifecycle_events: lifecycle_rx,
            }),
            Ok(Some(Err(error))) => {
                self.stop().await.ok();
                Err(error)
            }
            Ok(None) => {
                self.stop().await.ok();
                Err(process_error())
            }
            Err(_) => {
                self.stop().await.ok();
                Err(RuntimeError::new(
                    RuntimeErrorCode::AcpInitializeFailed,
                    "ACP initialize timed out",
                ))
            }
        }
    }

    async fn stop(&self) -> Result<(), RuntimeError> {
        let Some(control) = self.control.lock().await.take() else {
            return Ok(());
        };
        control.state.stopping.store(true, Ordering::Release);
        let (sender, receiver) = oneshot::channel();
        let _ = control.commands.send(ActorCommand::Stop(sender));
        stop_actor_task(control.task, receiver, STOP_TIMEOUT).await;
        let session_cwds = std::mem::take(&mut *self.session_cwds.lock().await);
        for session_cwd in session_cwds.into_values() {
            let _ = std::fs::remove_dir_all(session_cwd);
        }
        Ok(())
    }

    async fn create_session(
        &self,
        _session_id: &str,
        _title: Option<&str>,
        cwd: PathBuf,
    ) -> Result<String, RuntimeError> {
        let session_cwd = if self.runtime_cwd.is_some() {
            let session_cwd = cwd
                .join("sessions")
                .join(uuid::Uuid::new_v4().simple().to_string());
            std::fs::create_dir_all(&session_cwd).map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::SessionCreateFailed,
                    format!("Could not create Hermes session directory: {error}"),
                )
            })?;
            std::fs::canonicalize(session_cwd).map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::SessionCreateFailed,
                    format!("Could not resolve Hermes session directory: {error}"),
                )
            })?
        } else {
            cwd
        };
        let session_id = match self
            .command(|response| ActorCommand::CreateSession {
                cwd: session_cwd.clone(),
                response,
            })
            .await
        {
            Ok(session_id) => session_id,
            Err(error) => {
                if self.runtime_cwd.is_some() {
                    let _ = std::fs::remove_dir_all(&session_cwd);
                }
                return Err(error);
            }
        };
        self.session_cwds
            .lock()
            .await
            .insert(session_id.clone(), session_cwd);
        Ok(session_id)
    }

    async fn prompt(
        &self,
        request: DriverPromptRequest,
    ) -> Result<mpsc::UnboundedReceiver<DriverEvent>, RuntimeError> {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        self.command(|response| ActorCommand::Prompt {
            request,
            events: events_tx,
            response,
        })
        .await?;
        Ok(events_rx)
    }

    async fn cancel(&self, session_id: &str, run_id: &str) -> Result<(), RuntimeError> {
        let session_id = session_id.to_owned();
        let run_id = run_id.to_owned();
        let command_session_id = session_id.clone();
        self.command(|response| ActorCommand::Cancel {
            session_id: command_session_id,
            run_id,
            response,
        })
        .await?;

        // Hermes acknowledges `session/cancel`, but its terminal adapter may
        // leave the shell/process group it created behind.  The runtime cwd is
        // private to BiBit, so clean only non-Hermes processes in that cwd.
        // This keeps a cancelled run from leaving `sleep`, shells, or other
        // terminal descendants alive after the ACP run has ended.
        if let Some(session_cwd) = self.session_cwds.lock().await.get(&session_id).cloned() {
            cleanup_terminal_processes(&session_cwd).await;
        }
        Ok(())
    }

    async fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), RuntimeError> {
        let request_id = request_id.to_owned();
        self.command(|response| ActorCommand::ResolvePermission {
            request_id,
            decision,
            response,
        })
        .await
    }

    async fn cancel_permission(&self, request_id: &str) -> Result<(), RuntimeError> {
        self.command(|response| ActorCommand::CancelPermission {
            request_id: request_id.to_owned(),
            response,
        })
        .await
    }
}

async fn run_preflight(
    command: PathBuf,
    args: Vec<String>,
    runtime_cwd: Option<&Path>,
    timeout_duration: Duration,
) -> Result<(), RuntimeError> {
    let mut command = Command::new(command);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(runtime_cwd) = runtime_cwd {
        command
            .current_dir(runtime_cwd)
            .env("TERMINAL_CWD", runtime_cwd);
        #[cfg(unix)]
        command.env("PWD", runtime_cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|error| map_spawn_error(error, RuntimeErrorCode::HermesCheckFailed))?;
    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            return Err(map_spawn_error(error, RuntimeErrorCode::HermesCheckFailed));
        }
        Err(_) => {
            // `Child::kill()` 是 `start_kill()` + 无界 `wait()`。进程若卡在不可中断
            // 状态（D 状态、无响应子进程组），这一步会让 check/start 永久挂住，
            // 用户看到的是「Hermes 一直检查中」。只发信号，回收另给预算。
            let _ = child.start_kill();
            if timeout(STOP_TIMEOUT, child.wait()).await.is_err() {
                log::warn!("hermes_preflight_reap_timeout");
            }
            return Err(RuntimeError::new(
                RuntimeErrorCode::HermesCheckFailed,
                "Hermes check timed out",
            ));
        }
    };
    if status.success() {
        Ok(())
    } else {
        Err(RuntimeError::new(
            RuntimeErrorCode::HermesCheckFailed,
            "Hermes check failed",
        ))
    }
}

fn build_agent(
    spec: &HermesProcessSpec,
    runtime_cwd: Option<&Path>,
    state: Arc<ActorState>,
) -> Result<AcpAgent, RuntimeError> {
    let (command, args) = if let Some(runtime_cwd) = runtime_cwd {
        let current_exe = match &spec.process_launcher {
            Some(process_launcher) => process_launcher.clone(),
            None => std::env::current_exe().map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::HermesStartFailed,
                    "BiBit runtime launcher could not be resolved",
                )
            })?,
        };
        let runtime_cwd = runtime_cwd.to_str().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::HermesStartFailed,
                "Runtime working directory is not valid UTF-8",
            )
        })?;
        let hermes_command = spec.command.to_str().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::HermesStartFailed,
                "Hermes executable path is not valid UTF-8",
            )
        })?;
        let mut args = vec![
            PROCESS_LAUNCHER_ARG.into(),
            runtime_cwd.into(),
            hermes_command.into(),
        ];
        args.extend(spec.run_args.clone());
        (current_exe, args)
    } else {
        (spec.command.clone(), spec.run_args.clone())
    };
    let server = McpServer::Stdio(McpServerStdio::new("hermes", command).args(args));
    Ok(
        AcpAgent::new(server).with_debug(move |line, direction| match direction {
            LineDirection::Stdout => match serde_json::from_str::<Value>(line) {
                Ok(value) if serde_json::from_value::<RawJsonRpcMessage>(value.clone()).is_ok() => {
                    if value.get("error").is_some() {
                        state.saw_error_response.store(true, Ordering::Release);
                    }
                    if value.get("method").and_then(Value::as_str) == Some("session/update") {
                        if let Some(kind) = value
                            .pointer("/params/update/sessionUpdate")
                            .and_then(Value::as_str)
                        {
                            if !KNOWN_SESSION_UPDATES.contains(&kind) {
                                if let Some(session_id) =
                                    value.pointer("/params/sessionId").and_then(Value::as_str)
                                {
                                    let mut unknown_updates = state
                                        .unknown_updates
                                        .lock()
                                        .unwrap_or_else(|error| error.into_inner());
                                    *unknown_updates.entry(session_id.to_owned()).or_default() += 1;
                                }
                            }
                        }
                    }
                }
                _ => {
                    state.polluted_stdout.store(true, Ordering::Release);
                }
            },
            LineDirection::Stderr => append_stderr(&state, line.as_bytes()),
            LineDirection::Stdin => {}
        }),
    )
}

pub fn run_process_launcher(args: impl Iterator<Item = OsString>) -> i32 {
    let mut args = args;
    let Some(runtime_cwd) = args.next().map(PathBuf::from) else {
        return 2;
    };
    let Some(command) = args.next() else {
        return 2;
    };
    if !runtime_cwd.is_absolute()
        || std::fs::canonicalize(&runtime_cwd).ok().as_deref() != Some(runtime_cwd.as_path())
    {
        return 2;
    }

    let mut child = std::process::Command::new(command);
    child
        .args(args)
        .current_dir(&runtime_cwd)
        .env("TERMINAL_CWD", &runtime_cwd);
    #[cfg(unix)]
    {
        child.env("PWD", &runtime_cwd);
        use std::os::unix::process::CommandExt;

        let error = child.exec();
        return if error.kind() == io::ErrorKind::NotFound {
            127
        } else {
            126
        };
    }

    #[cfg(not(unix))]
    {
        match child.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 127,
            Err(_) => 126,
        }
    }
}

pub fn is_process_launcher_arg(arg: Option<&OsStr>) -> bool {
    arg == Some(OsStr::new(PROCESS_LAUNCHER_ARG))
}

#[cfg(unix)]
async fn cleanup_terminal_processes(runtime_cwd: &Path) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::{getpgid, getpgrp, Pid};
    use std::collections::BTreeSet;

    let Some(runtime_cwd) = runtime_cwd.to_str() else {
        return;
    };
    let own_pgid = getpgrp();
    let mut groups = BTreeSet::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|value| value.parse::<i32>().ok()) else {
            continue;
        };
        let proc_dir = entry.path();
        let Ok(cwd) = std::fs::read_link(proc_dir.join("cwd")) else {
            continue;
        };
        if cwd.to_str() != Some(runtime_cwd) {
            continue;
        }
        let cmdline = std::fs::read(proc_dir.join("cmdline"))
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).replace('\0', " "))
            .unwrap_or_default();
        if cmdline.is_empty()
            || cmdline.contains("hermes_cli")
            || cmdline.contains("hermes-agent")
            || cmdline.contains("bibit-gui")
        {
            continue;
        }
        let process_group = getpgid(Some(Pid::from_raw(pid)))
            .ok()
            .filter(|group| *group != own_pgid && group.as_raw() > 1);
        if let Some(group) = process_group {
            groups.insert(group);
        }
    }

    for group in &groups {
        log::info!(
            "Cancelling Hermes terminal process group {} in {}",
            group,
            runtime_cwd
        );
        let _ = killpg(*group, Signal::SIGTERM);
    }
    if groups.is_empty() {
        return;
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    for group in groups {
        let _ = killpg(group, Signal::SIGKILL);
    }
}

#[cfg(not(unix))]
async fn cleanup_terminal_processes(_runtime_cwd: &Path) {}

async fn connection_actor(
    connection: ConnectionTo<Agent>,
    mut commands: mpsc::UnboundedReceiver<ActorCommand>,
    state: Arc<ActorState>,
    startup: mpsc::UnboundedSender<Result<(), RuntimeError>>,
) -> Result<(), agent_client_protocol::Error> {
    state.initialize_attempted.store(true, Ordering::Release);
    let initialized = connection
        .send_request(
            InitializeRequest::new(ProtocolVersion::V1)
                .client_info(Implementation::new("BiBit", env!("CARGO_PKG_VERSION"))),
        )
        .block_task()
        .await;
    let initialized = match initialized {
        Ok(initialized) if initialized.protocol_version == ProtocolVersion::V1 => initialized,
        Ok(_) => {
            let _ = startup.send(Err(RuntimeError::new(
                RuntimeErrorCode::AcpInitializeFailed,
                "Hermes negotiated an unsupported ACP version",
            )));
            return Err(agent_client_protocol::Error::invalid_request());
        }
        Err(error) => {
            let _ = startup.send(Err(classify_initialize_error(&state)));
            return Err(error);
        }
    };
    let _ = initialized;
    state.initialized.store(true, Ordering::Release);
    let _ = startup.send(Ok(()));

    let (fatal_tx, mut fatal_rx) = mpsc::unbounded_channel::<()>();
    let mut sessions = HashMap::<String, Arc<Mutex<ActiveSession<'static, Agent>>>>::new();
    let mut prompt_tasks = Vec::<JoinHandle<()>>::new();
    while let Some(command) = tokio::select! {
        command = commands.recv() => command,
        Some(_) = fatal_rx.recv() => {
            abort_prompt_tasks(&mut prompt_tasks).await;
            return Err(agent_client_protocol::Error::invalid_request());
        }
    } {
        prompt_tasks.retain(|task| !task.is_finished());
        match command {
            ActorCommand::CreateSession { cwd, response } => {
                let result = match timeout(
                    SESSION_CREATE_TIMEOUT,
                    connection.build_session(cwd).block_task().start_session(),
                )
                .await
                {
                    Ok(Ok(session)) => {
                        let session_id = session.session_id().to_string();
                        sessions.insert(session_id.clone(), Arc::new(Mutex::new(session)));
                        Ok(session_id)
                    }
                    Ok(Err(_)) => Err(RuntimeError::new(
                        RuntimeErrorCode::SessionCreateFailed,
                        "Could not create Hermes session",
                    )),
                    Err(_) => Err(RuntimeError::new(
                        RuntimeErrorCode::SessionCreateFailed,
                        "Hermes session creation timed out",
                    )),
                };
                let _ = response.send(result);
            }
            ActorCommand::Prompt {
                request,
                events,
                response,
            } => {
                let Some(session) = sessions.get(&request.session_id).cloned() else {
                    let _ = response.send(Err(RuntimeError::new(
                        RuntimeErrorCode::SessionCreateFailed,
                        "Hermes session does not exist",
                    )));
                    continue;
                };
                state.active_runs.lock().await.insert(
                    request.session_id.clone(),
                    ActiveRun {
                        run_id: request.run_id.clone(),
                        events: events.clone(),
                    },
                );
                let prompt_state = state.clone();
                prompt_tasks.push(tokio::spawn(run_prompt(
                    connection.clone(),
                    session,
                    request,
                    events,
                    prompt_state,
                    fatal_tx.clone(),
                )));
                let _ = response.send(Ok(()));
            }
            ActorCommand::Cancel {
                session_id,
                run_id,
                response,
            } => {
                let active = state
                    .active_runs
                    .lock()
                    .await
                    .get(&session_id)
                    .is_some_and(|run| run.run_id == run_id);
                let result = if active {
                    cancel_permissions(&state, &session_id).await;
                    connection
                        .send_notification(CancelNotification::new(session_id))
                        .map_err(|_| process_error())
                } else {
                    Err(RuntimeError::new(
                        RuntimeErrorCode::RunConflict,
                        "Run is not active",
                    ))
                };
                let _ = response.send(result);
            }
            ActorCommand::ResolvePermission {
                request_id,
                decision,
                response,
            } => {
                let pending = state.permissions.lock().await.remove(&request_id);
                let result = pending
                    .ok_or_else(|| {
                        RuntimeError::new(
                            RuntimeErrorCode::PermissionExpired,
                            "Permission request expired",
                        )
                    })
                    .and_then(|pending| {
                        pending
                            .decision
                            .send(BrokerDecision::Resolve(decision))
                            .map_err(|_| {
                                RuntimeError::new(
                                    RuntimeErrorCode::PermissionExpired,
                                    "Permission request expired",
                                )
                            })
                    });
                let _ = response.send(result);
            }
            ActorCommand::CancelPermission {
                request_id,
                response,
            } => {
                let _ = response.send(cancel_permission_request(&state, &request_id).await);
            }
            ActorCommand::Stop(response) => {
                state.stopping.store(true, Ordering::Release);
                cancel_all_permissions(&state).await;
                abort_prompt_tasks(&mut prompt_tasks).await;
                let _ = response.send(());
                return Ok(());
            }
        }
    }
    Ok(())
}

async fn abort_prompt_tasks(tasks: &mut Vec<JoinHandle<()>>) {
    for task in tasks.drain(..) {
        task.abort();
        let _ = task.await;
    }
}

async fn permission_handler(
    request: RequestPermissionRequest,
    responder: agent_client_protocol::Responder<RequestPermissionResponse>,
    state: Arc<ActorState>,
) -> Result<(), agent_client_protocol::Error> {
    let session_id = request.session_id.to_string();
    let active = state
        .active_runs
        .lock()
        .await
        .get(&session_id)
        .map(|run| (run.run_id.clone(), run.events.clone()));
    let Some((run_id, events)) = active else {
        return responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ));
    };

    let allow_once = request
        .options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::AllowOnce)
        .map(|option| option.option_id.clone());
    let reject_once = request
        .options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::RejectOnce)
        .map(|option| option.option_id.clone());
    let request_id = uuid::Uuid::new_v4().to_string();
    let (decision_tx, decision_rx) = oneshot::channel();
    state.permissions.lock().await.insert(
        request_id.clone(),
        PendingPermission {
            session_id: session_id.clone(),
            decision: decision_tx,
        },
    );

    let tool_call_id = request.tool_call.tool_call_id.to_string();
    let title = request
        .tool_call
        .fields
        .title
        .clone()
        .unwrap_or_else(|| "Hermes tool".into());
    let input_summary = request.tool_call.fields.raw_input.clone().map(bound_value);
    let driver_request = DriverPermissionRequest {
        request_id: request_id.clone(),
        tool_call_id,
        title,
        description: "Hermes requests permission to use a tool".into(),
        tool_name: "tool".into(),
        input_summary,
        can_allow_once: allow_once.is_some(),
        can_deny: true,
        unsupported_decisions: request
            .options
            .iter()
            .filter(|option| {
                !matches!(
                    option.kind,
                    PermissionOptionKind::AllowOnce | PermissionOptionKind::RejectOnce
                )
            })
            .map(|option| format!("{:?}", option.kind))
            .collect(),
        allow_once_option_id: allow_once.as_ref().map(ToString::to_string),
        reject_once_option_id: reject_once.as_ref().map(ToString::to_string),
    };
    let _ = events.send(DriverEvent::PermissionRequested {
        run_id: run_id.clone(),
        request: driver_request,
    });

    let decision = wait_for_permission_decision(
        &state,
        &run_id,
        &request_id,
        &events,
        decision_rx,
        PERMISSION_TIMEOUT,
    )
    .await;
    let outcome = match decision {
        BrokerDecision::Resolve(PermissionDecision::AllowOnce) => allow_once
            .map(|option| {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option))
            })
            .unwrap_or(RequestPermissionOutcome::Cancelled),
        BrokerDecision::Resolve(PermissionDecision::Deny) => reject_once
            .map(|option| {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option))
            })
            .unwrap_or(RequestPermissionOutcome::Cancelled),
        BrokerDecision::Cancelled => RequestPermissionOutcome::Cancelled,
    };
    responder.respond(RequestPermissionResponse::new(outcome))
}

async fn wait_for_permission_decision(
    state: &ActorState,
    run_id: &str,
    request_id: &str,
    events: &mpsc::UnboundedSender<DriverEvent>,
    decision_rx: oneshot::Receiver<BrokerDecision>,
    timeout_duration: Duration,
) -> BrokerDecision {
    match timeout(timeout_duration, decision_rx).await {
        Ok(Ok(decision)) => decision,
        _ => {
            state.permissions.lock().await.remove(request_id);
            let _ = events.send(DriverEvent::PermissionExpired {
                run_id: run_id.to_owned(),
                request_id: request_id.to_owned(),
            });
            BrokerDecision::Resolve(PermissionDecision::Deny)
        }
    }
}

async fn extension_handler(
    notification: UntypedMessage,
    state: Arc<ActorState>,
) -> Result<(), agent_client_protocol::Error> {
    let params = notification.params().clone();
    let session_id = params.get("sessionId").and_then(Value::as_str);
    let runs = state.active_runs.lock().await;
    for (active_session_id, run) in runs.iter() {
        if session_id.is_none() || session_id == Some(active_session_id.as_str()) {
            let _ = run.events.send(DriverEvent::DiagnosticNotice {
                run_id: run.run_id.clone(),
                level: DiagnosticLevel::Info,
                message: "Hermes sent an extension notification".into(),
            });
        }
    }
    Ok(())
}

async fn protocol_notification_handler(
    notification: UntypedMessage,
    connection: ConnectionTo<Agent>,
    state: Arc<ActorState>,
) -> Result<Handled<(UntypedMessage, ConnectionTo<Agent>)>, agent_client_protocol::Error> {
    if notification.method().starts_with('_') {
        extension_handler(notification, state).await?;
        Ok(Handled::Yes)
    } else if notification.method() == "session/update" {
        Ok(Handled::No {
            message: (notification, connection),
            retry: false,
        })
    } else {
        unknown_notification_handler(notification, state).await?;
        Ok(Handled::Yes)
    }
}

async fn unknown_notification_handler(
    notification: UntypedMessage,
    state: Arc<ActorState>,
) -> Result<(), agent_client_protocol::Error> {
    let session_id = notification
        .params()
        .get("sessionId")
        .and_then(Value::as_str);
    let runs = state.active_runs.lock().await;
    for (active_session_id, run) in runs.iter() {
        if session_id.is_none() || session_id == Some(active_session_id.as_str()) {
            let _ = run.events.send(DriverEvent::DiagnosticNotice {
                run_id: run.run_id.clone(),
                level: DiagnosticLevel::Warning,
                message: "Hermes sent an unsupported notification".into(),
            });
        }
    }
    Ok(())
}

async fn run_prompt(
    connection: ConnectionTo<Agent>,
    session: Arc<Mutex<ActiveSession<'static, Agent>>>,
    request: DriverPromptRequest,
    events: mpsc::UnboundedSender<DriverEvent>,
    state: Arc<ActorState>,
    fatal_errors: mpsc::UnboundedSender<()>,
) {
    let mut session = session.lock().await;
    let mut tools = HashMap::<String, ToolCall>::new();
    if session.send_prompt(&request.prompt).is_err() {
        finish_failed_prompt(&request, &events, &state, process_error()).await;
        return;
    }

    loop {
        match session.read_update().await {
            Ok(SessionMessage::SessionMessage(dispatch)) => {
                let send_events = events.clone();
                let run_id = request.run_id.clone();
                let mapped = MatchDispatch::new(dispatch)
                    .if_notification(async |notification: SessionNotification| {
                        for event in map_update(&run_id, &mut tools, notification.update) {
                            if !send_event_if_active(
                                &state,
                                &request.session_id,
                                &run_id,
                                &send_events,
                                event,
                            )
                            .await
                            {
                                return Ok(());
                            }
                        }
                        Ok(())
                    })
                    .await
                    .otherwise_ignore();
                if mapped.is_err() {
                    if take_unknown_update(&state, &request.session_id) {
                        if !send_event_if_active(
                            &state,
                            &request.session_id,
                            &request.run_id,
                            &events,
                            DriverEvent::DiagnosticNotice {
                                run_id: request.run_id.clone(),
                                level: DiagnosticLevel::Info,
                                message: "Hermes sent an unsupported session update".into(),
                            },
                        )
                        .await
                        {
                            return;
                        }
                        continue;
                    }
                    let _ = connection
                        .send_notification(CancelNotification::new(request.session_id.clone()));
                    finish_failed_prompt(&request, &events, &state, protocol_error()).await;
                    if !drain_prompt(&mut session).await {
                        let _ = fatal_errors.send(());
                    }
                    return;
                }
            }
            Ok(SessionMessage::StopReason(reason)) => {
                while take_unknown_update(&state, &request.session_id) {
                    if !send_event_if_active(
                        &state,
                        &request.session_id,
                        &request.run_id,
                        &events,
                        DriverEvent::DiagnosticNotice {
                            run_id: request.run_id.clone(),
                            level: DiagnosticLevel::Info,
                            message: "Hermes sent an unsupported session update".into(),
                        },
                    )
                    .await
                    {
                        return;
                    }
                }
                if !finish_prompt(&request, &state).await {
                    return;
                }
                let event = if state.polluted_stdout.load(Ordering::Acquire) {
                    DriverEvent::Failed {
                        run_id: request.run_id.clone(),
                        error: run_error(&state),
                    }
                } else if reason == StopReason::Cancelled {
                    DriverEvent::Cancelled {
                        run_id: request.run_id.clone(),
                        reason: "user".into(),
                    }
                } else {
                    DriverEvent::Completed {
                        run_id: request.run_id.clone(),
                        stop_reason: stop_reason_name(reason).into(),
                    }
                };
                let _ = events.send(event);
                return;
            }
            Ok(_) => {
                if !send_event_if_active(
                    &state,
                    &request.session_id,
                    &request.run_id,
                    &events,
                    DriverEvent::DiagnosticNotice {
                        run_id: request.run_id.clone(),
                        level: DiagnosticLevel::Warning,
                        message: "Hermes sent an unsupported session message".into(),
                    },
                )
                .await
                {
                    return;
                }
            }
            Err(_) => {
                finish_failed_prompt(&request, &events, &state, run_error(&state)).await;
                return;
            }
        }
    }
}

async fn drain_prompt(session: &mut ActiveSession<'static, Agent>) -> bool {
    let drained = timeout(PROMPT_DRAIN_TIMEOUT, async {
        loop {
            match session.read_update().await {
                Ok(SessionMessage::StopReason(_)) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await;
    drained.is_ok()
}

async fn send_event_if_active(
    state: &ActorState,
    session_id: &str,
    run_id: &str,
    events: &mpsc::UnboundedSender<DriverEvent>,
    event: DriverEvent,
) -> bool {
    let runs = state.active_runs.lock().await;
    if !runs
        .get(session_id)
        .is_some_and(|active| active.run_id == run_id)
    {
        return false;
    }
    events.send(event).is_ok()
}

fn map_update(
    run_id: &str,
    tools: &mut HashMap<String, ToolCall>,
    update: SessionUpdate,
) -> Vec<DriverEvent> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => vec![map_content_chunk(run_id, chunk, false)],
        SessionUpdate::AgentThoughtChunk(chunk) => vec![map_content_chunk(run_id, chunk, true)],
        SessionUpdate::ToolCall(tool) => {
            let tool_call_id = tool.tool_call_id.to_string();
            tools.insert(tool_call_id.clone(), tool.clone());
            let mut events = vec![DriverEvent::ToolStarted {
                run_id: run_id.into(),
                tool_call_id,
                name: tool.title,
                input: tool.raw_input.map(bound_value),
            }];
            if !tool.content.is_empty() {
                events.push(DriverEvent::ToolUpdated {
                    run_id: run_id.into(),
                    tool_call_id: tool.tool_call_id.to_string(),
                    update: json!({"content": bound_serializable(&tool.content)}),
                });
            }
            events
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let tool_call_id = update.tool_call_id.to_string();
            let explicit_status = update.fields.status;
            if let Some(tool) = tools.get_mut(&tool_call_id) {
                tool.update(update.fields.clone());
            } else if let Ok(tool) = ToolCall::try_from(update.clone()) {
                tools.insert(tool_call_id.clone(), tool);
            }
            if matches!(
                explicit_status,
                Some(ToolCallStatus::Completed | ToolCallStatus::Failed)
            ) {
                let failed = explicit_status == Some(ToolCallStatus::Failed);
                let result = tools
                    .get(&tool_call_id)
                    .and_then(|tool| tool.raw_output.clone())
                    .or_else(|| update.fields.raw_output.clone())
                    .map(bound_value);
                vec![DriverEvent::ToolCompleted {
                    run_id: run_id.into(),
                    tool_call_id,
                    result: (!failed).then_some(result).flatten(),
                    error: failed.then(|| "Hermes tool failed".into()),
                }]
            } else {
                let update = tools
                    .get(&tool_call_id)
                    .map(bound_serializable)
                    .unwrap_or_else(|| bound_serializable(&update.fields));
                vec![DriverEvent::ToolUpdated {
                    run_id: run_id.into(),
                    tool_call_id,
                    update,
                }]
            }
        }
        SessionUpdate::UserMessageChunk(_) => vec![DriverEvent::DiagnosticNotice {
            run_id: run_id.into(),
            level: DiagnosticLevel::Info,
            message: "Hermes echoed user content".into(),
        }],
        SessionUpdate::Plan(plan) => vec![DriverEvent::DiagnosticNotice {
            run_id: run_id.into(),
            level: DiagnosticLevel::Info,
            message: safe_summary(&plan),
        }],
        // Hermes emits frequent metadata updates (available commands, current
        // mode, config, session info, usage) that carry no user-facing content.
        // Emitting a diagnostic notice for each one floods the message stream,
        // so these are silently ignored.
        SessionUpdate::AvailableCommandsUpdate(_)
        | SessionUpdate::CurrentModeUpdate(_)
        | SessionUpdate::ConfigOptionUpdate(_)
        | SessionUpdate::SessionInfoUpdate(_)
        | SessionUpdate::UsageUpdate(_) => vec![],
        _ => vec![DriverEvent::DiagnosticNotice {
            run_id: run_id.into(),
            level: DiagnosticLevel::Warning,
            message: "Hermes sent an unsupported session update".into(),
        }],
    }
}

fn map_content_chunk(run_id: &str, chunk: ContentChunk, reasoning: bool) -> DriverEvent {
    let message_id = chunk
        .message_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| {
            format!(
                "{}:{}",
                run_id,
                if reasoning { "reasoning" } else { "text" }
            )
        });
    match chunk.content {
        ContentBlock::Text(text) if reasoning => DriverEvent::ReasoningDelta {
            run_id: run_id.into(),
            message_id,
            delta: text.text,
        },
        ContentBlock::Text(text) => DriverEvent::TextDelta {
            run_id: run_id.into(),
            message_id,
            delta: text.text,
        },
        _ => DriverEvent::DiagnosticNotice {
            run_id: run_id.into(),
            level: DiagnosticLevel::Warning,
            message: "Hermes sent non-text message content".into(),
        },
    }
}

fn take_unknown_update(state: &ActorState, session_id: &str) -> bool {
    let mut unknown_updates = state
        .unknown_updates
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(count) = unknown_updates.get_mut(session_id) else {
        return false;
    };
    *count -= 1;
    if *count == 0 {
        unknown_updates.remove(session_id);
    }
    true
}

async fn finish_prompt(request: &DriverPromptRequest, state: &ActorState) -> bool {
    let removed = state
        .active_runs
        .lock()
        .await
        .remove(&request.session_id)
        .is_some();
    cancel_permissions(state, &request.session_id).await;
    removed
}

async fn finish_failed_prompt(
    request: &DriverPromptRequest,
    events: &mpsc::UnboundedSender<DriverEvent>,
    state: &ActorState,
    error: RuntimeError,
) {
    if finish_prompt(request, state).await {
        let _ = events.send(DriverEvent::Failed {
            run_id: request.run_id.clone(),
            error,
        });
    }
}

async fn cancel_permissions(state: &ActorState, session_id: &str) {
    let mut permissions = state.permissions.lock().await;
    let ids = permissions
        .iter()
        .filter(|(_, pending)| pending.session_id == session_id)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in ids {
        if let Some(pending) = permissions.remove(&id) {
            let _ = pending.decision.send(BrokerDecision::Cancelled);
        }
    }
}

async fn cancel_permission_request(
    state: &ActorState,
    request_id: &str,
) -> Result<(), RuntimeError> {
    let pending = state
        .permissions
        .lock()
        .await
        .remove(request_id)
        .ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::PermissionExpired,
                "Permission request expired",
            )
        })?;
    pending
        .decision
        .send(BrokerDecision::Cancelled)
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::PermissionExpired,
                "Permission request expired",
            )
        })
}

async fn cancel_all_permissions(state: &ActorState) {
    for (_, pending) in state.permissions.lock().await.drain() {
        let _ = pending.decision.send(BrokerDecision::Cancelled);
    }
}

async fn fail_active_runs(state: &ActorState, error: RuntimeError) {
    for (_, run) in state.active_runs.lock().await.drain() {
        let _ = run.events.send(DriverEvent::Failed {
            run_id: run.run_id,
            error: error.clone(),
        });
    }
    cancel_all_permissions(state).await;
}

fn classify_initialize_error(state: &ActorState) -> RuntimeError {
    if state.polluted_stdout.load(Ordering::Acquire) {
        RuntimeError::new(
            RuntimeErrorCode::AcpProtocolError,
            "Hermes emitted invalid ACP data",
        )
    } else if state.saw_error_response.load(Ordering::Acquire) {
        RuntimeError::new(
            RuntimeErrorCode::AcpInitializeFailed,
            "ACP initialize failed",
        )
    } else {
        process_error()
    }
}

fn classify_connection_error(
    state: &ActorState,
    _error: Option<&agent_client_protocol::Error>,
) -> RuntimeError {
    if state.polluted_stdout.load(Ordering::Acquire) {
        RuntimeError::new(
            RuntimeErrorCode::AcpProtocolError,
            "Hermes emitted invalid ACP data",
        )
    } else if !state.initialize_attempted.load(Ordering::Acquire) {
        RuntimeError::new(
            RuntimeErrorCode::HermesStartFailed,
            "Could not start Hermes",
        )
    } else {
        process_error()
    }
}

fn run_error(state: &ActorState) -> RuntimeError {
    if state.polluted_stdout.load(Ordering::Acquire) {
        RuntimeError::new(
            RuntimeErrorCode::AcpProtocolError,
            "Hermes emitted invalid ACP data",
        )
    } else {
        process_error()
    }
}

fn protocol_error() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AcpProtocolError,
        "Hermes sent an invalid ACP update",
    )
}

fn append_stderr(state: &ActorState, bytes: &[u8]) {
    let mut tail = state
        .stderr_tail
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    tail.extend(bytes.iter().copied());
    tail.push_back(b'\n');
    while tail.len() > STDERR_LIMIT {
        tail.pop_front();
    }
}

fn bound_serializable(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value)
        .map(bound_value)
        .unwrap_or_else(|_| json!({"truncated": true}))
}

fn safe_summary(value: &impl serde::Serialize) -> String {
    let value = bound_serializable(value);
    serde_json::to_string(&value).unwrap_or_else(|_| "Hermes update".into())
}

fn bound_value(value: Value) -> Value {
    let Ok(bytes) = serde_json::to_vec(&value) else {
        return json!({"truncated": true});
    };
    if bytes.len() <= MAX_TOOL_VALUE_BYTES {
        return value;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut end = MAX_TOOL_VALUE_BYTES.saturating_sub(128).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!({"truncated": true, "preview": &text[..end]})
}

async fn stop_actor_task(
    mut task: JoinHandle<()>,
    receiver: oneshot::Receiver<()>,
    timeout_duration: Duration,
) {
    let graceful = async {
        let _ = receiver.await;
        let _ = (&mut task).await;
    };
    if timeout(timeout_duration, graceful).await.is_err() {
        task.abort();
        // abort 是协作式的：任务若停在不可取消的等待里，`await` 不会返回，
        // 停止路径就跟着一起卡住。留痕并放手，比让调用方无限等待好。
        if timeout(STOP_TIMEOUT, &mut task).await.is_err() {
            log::warn!("hermes_actor_stop_timeout");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_preflight_checks_the_stable_acp_entrypoint() {
        let spec = HermesProcessSpec::default();
        assert_eq!(spec.check_args, vec!["acp", "--help"]);
        assert_eq!(spec.run_args, vec!["acp"]);
    }

    #[tokio::test]
    async fn permission_timeout_expires_the_driver_request() {
        let state = ActorState::default();
        let (decision, decision_rx) = oneshot::channel();
        state.permissions.lock().await.insert(
            "permission-1".into(),
            PendingPermission {
                session_id: "session-1".into(),
                decision,
            },
        );
        let (events, mut receiver) = mpsc::unbounded_channel();

        let decision = wait_for_permission_decision(
            &state,
            "run-1",
            "permission-1",
            &events,
            decision_rx,
            Duration::from_millis(1),
        )
        .await;

        assert!(matches!(
            decision,
            BrokerDecision::Resolve(PermissionDecision::Deny)
        ));
        assert!(state.permissions.lock().await.is_empty());
        assert!(matches!(
            receiver.recv().await,
            Some(DriverEvent::PermissionExpired { run_id, request_id })
                if run_id == "run-1" && request_id == "permission-1"
        ));
    }

    #[tokio::test]
    async fn abandoning_permission_cancels_the_acp_request() {
        let state = ActorState::default();
        let (decision, decision_rx) = oneshot::channel();
        state.permissions.lock().await.insert(
            "permission-1".into(),
            PendingPermission {
                session_id: "session-1".into(),
                decision,
            },
        );

        cancel_permission_request(&state, "permission-1")
            .await
            .unwrap();

        assert!(state.permissions.lock().await.is_empty());
        assert!(matches!(decision_rx.await, Ok(BrokerDecision::Cancelled)));
    }

    #[tokio::test]
    async fn stop_wait_aborts_actor_when_acknowledged_but_task_hangs() {
        let (ack_tx, ack_rx) = oneshot::channel();
        let task = tokio::spawn(async {
            std::future::pending::<()>().await;
        });
        ack_tx.send(()).unwrap();

        timeout(
            Duration::from_millis(200),
            stop_actor_task(task, ack_rx, Duration::from_millis(10)),
        )
        .await
        .expect("stop should abort a hung actor task");
    }

    #[test]
    fn tool_content_is_summarized_and_missing_output_stays_none() {
        let initial: SessionUpdate = serde_json::from_value(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tool-1",
            "title": "编辑文件",
            "status": "in_progress",
            "content": [
                {"type": "diff", "path": "/tmp/a.txt", "newText": "新内容"},
                {"type": "terminal", "terminalId": "terminal-1"}
            ],
            "rawInput": {"path": "/tmp/a.txt"}
        }))
        .unwrap();
        let mut tools = HashMap::new();
        let events = map_update("run-1", &mut tools, initial);
        assert!(events
            .iter()
            .any(|event| matches!(event, DriverEvent::ToolStarted { .. })));
        assert!(events.iter().any(|event| {
            matches!(event, DriverEvent::ToolUpdated { update, .. } if update["content"].is_array())
        }));

        let completed: SessionUpdate = serde_json::from_value(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "status": "completed"
        }))
        .unwrap();
        let events = map_update("run-1", &mut tools, completed);
        assert!(events.iter().any(|event| {
            matches!(
                event,
                DriverEvent::ToolCompleted {
                    result: None,
                    error: None,
                    ..
                }
            )
        }));

        let follow_up: SessionUpdate = serde_json::from_value(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tool-1",
            "rawOutput": {"ignored": true}
        }))
        .unwrap();
        let events = map_update("run-1", &mut tools, follow_up);
        assert!(events
            .iter()
            .any(|event| matches!(event, DriverEvent::ToolUpdated { .. })));
        assert!(!events
            .iter()
            .any(|event| matches!(event, DriverEvent::ToolCompleted { .. })));
    }

    #[test]
    fn unknown_update_markers_are_consumed_per_session() {
        let state = ActorState::default();
        state
            .unknown_updates
            .lock()
            .unwrap()
            .insert("session-1".into(), 1);
        assert!(take_unknown_update(&state, "session-1"));
        assert!(!take_unknown_update(&state, "session-1"));
        assert!(!take_unknown_update(&state, "session-2"));
    }

    #[tokio::test]
    async fn preflight_returns_within_its_budget_when_the_child_must_be_killed() {
        let error = timeout(
            Duration::from_secs(5),
            run_preflight(
                PathBuf::from("sh"),
                vec!["-c".to_owned(), "sleep 30".to_owned()],
                None,
                Duration::from_millis(100),
            ),
        )
        .await
        .expect("预检查必须在超时 + 回收预算内返回，不能等子进程自己结束")
        .expect_err("一个不返回的子进程不能通过预检查");
        assert_eq!(error.code, RuntimeErrorCode::HermesCheckFailed);
    }

    #[tokio::test]
    async fn inactive_run_rejects_late_updates() {
        let state = ActorState::default();
        let (events, mut receiver) = mpsc::unbounded_channel();
        state.active_runs.lock().await.insert(
            "session-1".into(),
            ActiveRun {
                run_id: "run-1".into(),
                events: events.clone(),
            },
        );
        state.active_runs.lock().await.remove("session-1");

        assert!(
            !send_event_if_active(
                &state,
                "session-1",
                "run-1",
                &events,
                DriverEvent::TextDelta {
                    run_id: "run-1".into(),
                    message_id: "message-1".into(),
                    delta: "late".into(),
                },
            )
            .await
        );
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preflight_timeout_reaps_the_child_without_buffering_output() {
        let temp = tempfile::tempdir().unwrap();
        let pid_path = temp.path().join("pid");
        let script = format!(
            "echo $$ > {}; printf '%*s' 2000000 x; sleep 10",
            pid_path.display()
        );
        let error = run_preflight(
            PathBuf::from("sh"),
            vec!["-c".into(), script],
            None,
            Duration::from_millis(50),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::HermesCheckFailed);

        let pid = std::fs::read_to_string(pid_path).unwrap();
        let status = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "preflight child must be reaped");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_cleanup_kills_terminal_process_group_in_runtime_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let mut child = Command::new("setsid")
            .args(["sh", "-c", "sleep 30"])
            .current_dir(temp.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();

        tokio::time::sleep(Duration::from_millis(100)).await;
        cleanup_terminal_processes(temp.path()).await;
        timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("terminal process group should exit after cancellation")
            .unwrap();
    }
}

fn stop_reason_name(reason: StopReason) -> &'static str {
    match reason {
        StopReason::EndTurn => "end_turn",
        StopReason::MaxTokens => "max_tokens",
        StopReason::MaxTurnRequests => "max_turn_requests",
        StopReason::Refusal => "refusal",
        StopReason::Cancelled => "cancelled",
        _ => "end_turn",
    }
}

fn process_error() -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::ProcessExited, "Hermes process exited")
}

fn stopped_error() -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::HermesStartFailed, "Hermes is stopped")
}

fn map_spawn_error(error: io::Error, fallback: RuntimeErrorCode) -> RuntimeError {
    let code = if error.kind() == io::ErrorKind::NotFound {
        RuntimeErrorCode::HermesNotFound
    } else {
        fallback
    };
    RuntimeError::new(
        code,
        if code == RuntimeErrorCode::HermesNotFound {
            "Hermes was not found"
        } else {
            "Could not start Hermes"
        },
    )
}
