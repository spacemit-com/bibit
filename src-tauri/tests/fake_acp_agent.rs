use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const AGENT_BIN: &str = env!("CARGO_BIN_EXE_bibit-gui");
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(1);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

enum OutputEvent {
    Line(String),
    Eof,
    Error(String),
}

struct AgentProcess {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Receiver<OutputEvent>,
    stderr: Receiver<String>,
}

impl AgentProcess {
    fn spawn(scenario: &str) -> Self {
        Self::spawn_args(&["--scenario", scenario])
    }

    fn spawn_args(args: &[&str]) -> Self {
        let mut command = Command::new(AGENT_BIN);
        command.arg("--runtime-test-agent").args(args);
        Self::spawn_command(command)
    }

    fn spawn_command(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("fake ACP agent should start");
        let stdin = child.stdin.take().expect("stdin should be piped");
        let stdout = child.stdout.take().expect("stdout should be piped");
        let stderr = child.stderr.take().expect("stderr should be piped");

        let (stdout_sender, stdout_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if stdout_sender.send(OutputEvent::Line(line)).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = stdout_sender.send(OutputEvent::Error(error.to_string()));
                        return;
                    }
                }
            }
            let _ = stdout_sender.send(OutputEvent::Eof);
        });

        let (stderr_sender, stderr_receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut output = String::new();
            let value = match reader.read_to_string(&mut output) {
                Ok(_) => output,
                Err(error) => format!("failed to read stderr: {error}"),
            };
            let _ = stderr_sender.send(value);
        });

        Self {
            child: Some(child),
            stdin: Some(stdin),
            stdout: stdout_receiver,
            stderr: stderr_receiver,
        }
    }

    fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().expect("agent stdin should be open");
        serde_json::to_writer(&mut *stdin, &message).expect("request should serialize");
        stdin.write_all(b"\n").expect("request should be written");
        stdin.flush().expect("request should be flushed");
    }

    fn send_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("agent stdin should be open");
        stdin
            .write_all(line.as_bytes())
            .expect("line should be written");
        stdin.write_all(b"\n").expect("newline should be written");
        stdin.flush().expect("line should be flushed");
    }

    fn read_line(&self) -> String {
        match self.stdout.recv_timeout(IO_TIMEOUT) {
            Ok(OutputEvent::Line(line)) => line,
            Ok(OutputEvent::Eof) => panic!("agent stdout closed before the expected line"),
            Ok(OutputEvent::Error(error)) => panic!("failed to read agent stdout: {error}"),
            Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for agent stdout"),
            Err(RecvTimeoutError::Disconnected) => panic!("agent stdout reader disconnected"),
        }
    }

    fn read_json(&self) -> Value {
        let line = self.read_line();
        serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("agent stdout was not JSON: {error}; line={line:?}"))
    }

    fn assert_no_output(&self) {
        match self.stdout.recv_timeout(Duration::from_millis(200)) {
            Err(RecvTimeoutError::Timeout) => {}
            Ok(OutputEvent::Line(line)) => panic!("unexpected agent output: {line}"),
            Ok(OutputEvent::Eof) => {
                panic!("agent exited while output was expected to remain pending")
            }
            Ok(OutputEvent::Error(error)) => panic!("failed to read agent stdout: {error}"),
            Err(RecvTimeoutError::Disconnected) => panic!("agent stdout reader disconnected"),
        }
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn finish(mut self) -> (ExitStatus, String) {
        self.close_stdin();
        match self.stdout.recv_timeout(IO_TIMEOUT) {
            Ok(OutputEvent::Eof) => {}
            Ok(OutputEvent::Line(line)) => panic!("unexpected trailing agent output: {line}"),
            Ok(OutputEvent::Error(error)) => panic!("failed to read agent stdout: {error}"),
            Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for agent stdout to close"),
            Err(RecvTimeoutError::Disconnected) => panic!("agent stdout reader disconnected"),
        }
        let deadline = Instant::now() + PROCESS_EXIT_TIMEOUT;
        let status = loop {
            let child = self.child.as_mut().expect("child should be present");
            match child.try_wait().expect("agent should be waitable") {
                Some(status) => break status,
                None if Instant::now() >= deadline => {
                    child.kill().expect("timed-out agent should be killable");
                    break child.wait().expect("killed agent should be waitable");
                }
                None => std::thread::sleep(PROCESS_POLL_INTERVAL),
            }
        };
        self.child.take();
        let stderr = self
            .stderr
            .recv_timeout(IO_TIMEOUT)
            .expect("stderr reader should finish");
        (status, stderr)
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn initialize(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {"name": "bibit-test-client", "version": "1"}
        }
    })
}

fn new_session(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/new",
        "params": {"cwd": "/tmp", "mcpServers": []}
    })
}

fn prompt(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": "fake-session-1",
            "prompt": [{"type": "text", "text": "请搜索最新消息"}]
        }
    })
}

fn handshake(agent: &mut AgentProcess) {
    agent.send(initialize(json!(1)));
    let initialized = agent.read_json();
    assert_eq!(initialized["id"], 1);
    assert_eq!(initialized["result"]["protocolVersion"], 1);

    agent.send(new_session(json!("new-1")));
    let session = agent.read_json();
    assert_eq!(session["id"], "new-1");
    assert_eq!(session["result"]["sessionId"], "fake-session-1");
}

fn assert_update(message: &Value, kind: &str) {
    assert_eq!(message["jsonrpc"], "2.0");
    assert_eq!(message["method"], "session/update");
    assert!(message.get("id").is_none());
    assert_eq!(message["params"]["sessionId"], "fake-session-1");
    assert_eq!(message["params"]["update"]["sessionUpdate"], kind);
}

#[test]
fn check_reports_stable_health_information() {
    let agent = AgentProcess::spawn_args(&["--check"]);
    assert_eq!(agent.read_line(), "bibit-fake-acp-agent 1 healthy");
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn happy_scenario_streams_updates_and_preserves_request_ids() {
    let mut agent = AgentProcess::spawn("happy");

    agent.send(initialize(json!("initialize-1")));
    let initialized = agent.read_json();
    assert_eq!(initialized["id"], "initialize-1");
    assert_eq!(initialized["result"]["protocolVersion"], 1);
    assert_eq!(
        initialized["result"]["agentCapabilities"]["loadSession"],
        false
    );
    assert_eq!(
        initialized["result"]["agentInfo"]["name"],
        "bibit-fake-acp-agent"
    );
    assert_eq!(initialized["result"]["agentInfo"]["version"], "1");

    agent.send(new_session(json!(2)));
    let session = agent.read_json();
    assert_eq!(session["id"], 2);
    assert_eq!(session["result"]["sessionId"], "fake-session-1");

    agent.send(prompt(json!("prompt-1")));
    let thought = agent.read_json();
    let first_text = agent.read_json();
    let second_text = agent.read_json();
    let tool_call = agent.read_json();
    let tool_completed = agent.read_json();
    let completed = agent.read_json();

    assert_update(&thought, "agent_thought_chunk");
    assert_eq!(thought["params"]["update"]["content"]["type"], "text");
    assert_eq!(thought["params"]["update"]["content"]["text"], "正在思考");
    assert_update(&first_text, "agent_message_chunk");
    assert_eq!(first_text["params"]["update"]["content"]["text"], "你");
    assert_update(&second_text, "agent_message_chunk");
    assert_eq!(second_text["params"]["update"]["content"]["text"], "好");
    assert_update(&tool_call, "tool_call");
    assert_eq!(tool_call["params"]["update"]["toolCallId"], "fake-tool-1");
    assert_eq!(tool_call["params"]["update"]["status"], "in_progress");
    assert_update(&tool_completed, "tool_call_update");
    assert_eq!(tool_completed["params"]["update"]["status"], "completed");
    assert_eq!(
        tool_completed["params"]["update"]["rawOutput"]["result"],
        "工具调用成功"
    );
    assert_eq!(completed["id"], "prompt-1");
    assert_eq!(completed["result"]["stopReason"], "end_turn");

    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn initialize_failed_returns_a_stable_error_with_the_original_id() {
    let mut agent = AgentProcess::spawn("initialize_failed");
    agent.send(initialize(json!("init-error")));
    let response = agent.read_json();
    assert_eq!(response["id"], "init-error");
    assert_eq!(response["error"]["code"], -32001);
    assert_eq!(response["error"]["message"], "fake initialize failure");
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn permission_waits_for_the_client_response_before_ending_the_prompt() {
    let mut agent = AgentProcess::spawn("permission");
    handshake(&mut agent);
    agent.send(prompt(json!(31)));

    let request = agent.read_json();
    assert_eq!(request["id"], "permission-rpc-1");
    assert_eq!(request["method"], "session/request_permission");
    assert_eq!(request["params"]["sessionId"], "fake-session-1");
    assert_eq!(request["params"]["toolCall"]["toolCallId"], "fake-tool-1");
    assert_eq!(request["params"]["options"][0]["kind"], "allow_once");
    assert_eq!(request["params"]["options"][1]["kind"], "reject_once");
    agent.assert_no_output();

    agent.send(json!({
        "jsonrpc": "2.0",
        "id": "permission-rpc-1",
        "error": {"code": -32000, "message": "client permission failure"},
        "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}
    }));
    agent.assert_no_output();

    agent.send(json!({
        "jsonrpc": "2.0",
        "id": "permission-rpc-1",
        "result": {"outcome": {"outcome": "selected", "optionId": "not-offered"}}
    }));
    agent.assert_no_output();

    agent.send(json!({
        "jsonrpc": "2.0",
        "id": "permission-rpc-1",
        "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}
    }));
    let completed = agent.read_json();
    assert_eq!(completed["id"], 31);
    assert_eq!(completed["result"]["stopReason"], "end_turn");
    assert_eq!(
        completed["result"]["_meta"]["permissionDecision"],
        "allow-once"
    );

    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn permission_accepts_the_offered_reject_once_decision() {
    let mut agent = AgentProcess::spawn("permission");
    handshake(&mut agent);
    agent.send(prompt(json!(32)));
    let request = agent.read_json();
    assert_eq!(request["id"], "permission-rpc-1");

    agent.send(json!({
        "jsonrpc": "2.0",
        "id": "permission-rpc-1",
        "result": {"outcome": {"outcome": "selected", "optionId": "reject-once"}}
    }));
    let completed = agent.read_json();
    assert_eq!(completed["id"], 32);
    assert_eq!(completed["result"]["stopReason"], "end_turn");
    assert_eq!(
        completed["result"]["_meta"]["permissionDecision"],
        "reject-once"
    );

    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[cfg(unix)]
#[test]
fn finish_kills_a_child_that_closes_stdout_without_exiting() {
    let mut command = Command::new("sh");
    command.args(["-c", "exec 1>&-; exec sleep 3"]);
    let agent = AgentProcess::spawn_command(command);
    let started = Instant::now();

    let (_status, _stderr) = agent.finish();

    assert!(
        started.elapsed() < Duration::from_secs(2),
        "finish exceeded its process-exit deadline: {:?}",
        started.elapsed()
    );
}

#[test]
fn cancel_notification_ends_the_pending_prompt_without_its_own_response() {
    let mut agent = AgentProcess::spawn("cancel");
    handshake(&mut agent);
    agent.send(prompt(json!(41)));
    agent.assert_no_output();
    agent.send(json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": {"sessionId": "fake-session-1"}
    }));

    let completed = agent.read_json();
    assert_eq!(completed["id"], 41);
    assert_eq!(completed["result"]["stopReason"], "cancelled");

    agent.send(json!({"jsonrpc": "2.0", "id": "after-cancel", "method": "unknown"}));
    let next = agent.read_json();
    assert_eq!(next["id"], "after-cancel");
    assert_eq!(next["error"]["code"], -32601);
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn tool_failed_reports_a_failed_tool_update_then_ends_the_turn() {
    let mut agent = AgentProcess::spawn("tool_failed");
    handshake(&mut agent);
    agent.send(prompt(json!(51)));
    let started = agent.read_json();
    let failed = agent.read_json();
    let completed = agent.read_json();
    assert_update(&started, "tool_call");
    assert_update(&failed, "tool_call_update");
    assert_eq!(failed["params"]["update"]["status"], "failed");
    assert_eq!(
        failed["params"]["update"]["rawOutput"]["error"],
        "fake tool failure"
    );
    assert_eq!(completed["id"], 51);
    assert_eq!(completed["result"]["stopReason"], "end_turn");
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn polluted_stdout_emits_one_deliberately_invalid_line() {
    let mut agent = AgentProcess::spawn("polluted_stdout");
    handshake(&mut agent);
    agent.send(prompt(json!(61)));
    assert_eq!(agent.read_line(), "not-json");
    for expected_kind in [
        "agent_thought_chunk",
        "agent_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
    ] {
        assert_update(&agent.read_json(), expected_kind);
    }
    let completed = agent.read_json();
    assert_eq!(completed["id"], 61);
    assert_eq!(completed["result"]["stopReason"], "end_turn");
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn stderr_exit_writes_a_safe_diagnostic_and_exits_with_code_17_at_startup() {
    let agent = AgentProcess::spawn("stderr_exit");
    let (status, stderr) = agent.finish();
    assert_eq!(status.code(), Some(17));
    assert_eq!(stderr, "fake ACP agent startup failure\n");
}

#[test]
fn exit_mid_prompt_exits_without_a_terminal_prompt_response() {
    let mut agent = AgentProcess::spawn("exit_mid_prompt");
    handshake(&mut agent);
    agent.send(prompt(json!(71)));
    let (status, stderr) = agent.finish();
    assert_eq!(status.code(), Some(23));
    assert!(stderr.is_empty());
}

#[test]
fn unknown_session_update_is_emitted_before_a_normal_end_turn() {
    let mut agent = AgentProcess::spawn("unknown_notification");
    handshake(&mut agent);
    agent.send(prompt(json!(81)));
    let unknown = agent.read_json();
    assert_update(&unknown, "future_update");
    assert_eq!(unknown["params"]["update"]["detail"], "fake extension");
    let completed = agent.read_json();
    assert_eq!(completed["id"], 81);
    assert_eq!(completed["result"]["stopReason"], "end_turn");
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn long_utf8_tool_result_is_valid_and_exceeds_64_kib() {
    let mut agent = AgentProcess::spawn("long_utf8_tool_result");
    handshake(&mut agent);
    agent.send(prompt(json!(91)));
    let update = agent.read_json();
    assert_update(&update, "tool_call_update");
    assert_eq!(update["params"]["update"]["status"], "completed");
    let result = update["params"]["update"]["rawOutput"]["result"]
        .as_str()
        .expect("long result should be a UTF-8 JSON string");
    assert!(
        result.len() > 65_536,
        "result was only {} UTF-8 bytes",
        result.len()
    );
    assert!(result.chars().all(|character| character == '界'));
    let completed = agent.read_json();
    assert_eq!(completed["id"], 91);
    assert_eq!(completed["result"]["stopReason"], "end_turn");
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn method_not_found_preserves_number_and_string_ids_and_notifications_are_ignored() {
    let mut agent = AgentProcess::spawn("happy");
    agent.send(json!({"jsonrpc": "2.0", "id": 101, "method": "missing/number"}));
    let number = agent.read_json();
    assert_eq!(number["id"], 101);
    assert_eq!(number["error"]["code"], -32601);

    agent.send(json!({"jsonrpc": "2.0", "method": "unknown/notification"}));
    agent.send(json!({"jsonrpc": "2.0", "id": "string-id", "method": "missing/string"}));
    let string = agent.read_json();
    assert_eq!(string["id"], "string-id");
    assert_eq!(string["error"]["code"], -32601);
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn malformed_json_returns_a_parse_error_and_keeps_serving_requests() {
    let mut agent = AgentProcess::spawn("happy");
    agent.send_raw("{broken-json");
    let parse_error = agent.read_json();
    assert!(parse_error["id"].is_null());
    assert_eq!(parse_error["error"]["code"], -32700);
    assert_eq!(parse_error["error"]["message"], "parse error");

    agent.send(json!({"jsonrpc": "2.0", "id": 111, "method": "still-running"}));
    let response = agent.read_json();
    assert_eq!(response["id"], 111);
    assert_eq!(response["error"]["code"], -32601);
    let (status, stderr) = agent.finish();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn missing_and_unknown_arguments_fail_without_panicking() {
    for args in [&[][..], &["--scenario", "unknown"][..], &["--wrong"][..]] {
        let agent = AgentProcess::spawn_args(args);
        let (status, stderr) = agent.finish();
        assert!(!status.success());
        assert!(stderr.contains("Usage: bibit-fake-acp-agent"));
        assert!(!stderr.contains("panicked"));
    }
}
