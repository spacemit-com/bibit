use serde_json::{json, Map, Value};
use std::io::{self, BufRead, Write};
use std::process;

const SESSION_ID: &str = "fake-session-1";
const TOOL_CALL_ID: &str = "fake-tool-1";
const USAGE: &str = "Usage: bibit-fake-acp-agent --check | --scenario <happy|process_context|initialize_failed|session_new_hang|permission|cancel|tool_failed|polluted_stdout|json_object_stdout|stderr_exit|exit_mid_prompt|queued_updates_then_exit|unknown_notification|unknown_method|invalid_update|invalid_update_no_terminal|long_utf8_tool_result>";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scenario {
    Happy,
    ProcessContext,
    InitializeFailed,
    SessionNewHang,
    Permission,
    Cancel,
    ToolFailed,
    PollutedStdout,
    JsonObjectStdout,
    StderrExit,
    ExitMidPrompt,
    QueuedUpdatesThenExit,
    UnknownNotification,
    UnknownMethod,
    InvalidUpdate,
    InvalidUpdateNoTerminal,
    LongUtf8ToolResult,
}

enum Mode {
    Check,
    Scenario(Scenario),
}

pub(crate) fn run(args: impl Iterator<Item = String>) {
    let mode = match parse_args(args) {
        Ok(mode) => mode,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            process::exit(2);
        }
    };

    match mode {
        Mode::Check => println!("bibit-fake-acp-agent 1 healthy"),
        Mode::Scenario(Scenario::StderrExit) => {
            eprintln!("fake ACP agent startup failure");
            process::exit(17);
        }
        Mode::Scenario(scenario) => {
            if let Err(error) = serve(scenario) {
                eprintln!("fake ACP agent I/O failure: {error}");
                process::exit(1);
            }
        }
    }
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Mode, String> {
    let args: Vec<String> = args.collect();
    match args.as_slice() {
        [flag] if flag == "--check" => Ok(Mode::Check),
        [flag, scenario] if flag == "--scenario" => parse_scenario(scenario).map(Mode::Scenario),
        [] => Err("missing arguments".to_string()),
        _ => Err("invalid arguments".to_string()),
    }
}

fn parse_scenario(value: &str) -> Result<Scenario, String> {
    match value {
        "happy" => Ok(Scenario::Happy),
        "process_context" => Ok(Scenario::ProcessContext),
        "initialize_failed" => Ok(Scenario::InitializeFailed),
        "session_new_hang" => Ok(Scenario::SessionNewHang),
        "permission" => Ok(Scenario::Permission),
        "cancel" => Ok(Scenario::Cancel),
        "tool_failed" => Ok(Scenario::ToolFailed),
        "polluted_stdout" => Ok(Scenario::PollutedStdout),
        "json_object_stdout" => Ok(Scenario::JsonObjectStdout),
        "stderr_exit" => Ok(Scenario::StderrExit),
        "exit_mid_prompt" => Ok(Scenario::ExitMidPrompt),
        "queued_updates_then_exit" => Ok(Scenario::QueuedUpdatesThenExit),
        "unknown_notification" => Ok(Scenario::UnknownNotification),
        "unknown_method" => Ok(Scenario::UnknownMethod),
        "invalid_update" => Ok(Scenario::InvalidUpdate),
        "invalid_update_no_terminal" => Ok(Scenario::InvalidUpdateNoTerminal),
        "long_utf8_tool_result" => Ok(Scenario::LongUtf8ToolResult),
        _ => Err(format!("unknown scenario: {value}")),
    }
}

fn serve(scenario: Scenario) -> io::Result<()> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let stdout = io::stdout();
    let mut output = stdout.lock();

    while let Some(line) = lines.next() {
        let line = line?;
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => {
                reply_error(&mut output, Value::Null, -32700, "parse error")?;
                continue;
            }
        };

        let Some(object) = message.as_object() else {
            reply_error(&mut output, Value::Null, -32600, "invalid request")?;
            continue;
        };
        if !object.contains_key("method") {
            continue;
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            if object.contains_key("id") {
                reply_error(
                    &mut output,
                    object.get("id").cloned().unwrap_or(Value::Null),
                    -32600,
                    "invalid request",
                )?;
            }
            continue;
        };
        let id = object.get("id").cloned();

        match (method, id) {
            ("initialize", Some(id)) if scenario == Scenario::InitializeFailed => {
                reply_error(&mut output, id, -32001, "fake initialize failure")?;
            }
            ("initialize", Some(id)) => reply(
                &mut output,
                id,
                json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": false},
                    "agentInfo": {"name": "bibit-fake-acp-agent", "version": "1"}
                }),
            )?,
            ("session/new", Some(_id)) if scenario == Scenario::SessionNewHang => {
                // Keep the ACP process alive but never answer session/new.
            }
            ("session/new", Some(id)) if scenario == Scenario::ProcessContext => {
                let requested_cwd = object
                    .get("params")
                    .and_then(|params| params.get("cwd"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let process_cwd = std::env::current_dir()
                    .ok()
                    .and_then(|path| path.to_str().map(str::to_owned))
                    .unwrap_or_default();
                let terminal_cwd = std::env::var("TERMINAL_CWD").unwrap_or_default();
                let process_pwd = std::env::var("PWD").unwrap_or_default();
                let pwd_matches = cfg!(windows) || process_pwd == process_cwd;
                let requested_is_child =
                    std::path::Path::new(&requested_cwd).starts_with(&process_cwd);
                if process_cwd == terminal_cwd && pwd_matches && requested_is_child {
                    reply(&mut output, id, json!({"sessionId": SESSION_ID}))?;
                } else {
                    reply_error(&mut output, id, -32002, "fake process context mismatch")?;
                }
            }
            ("session/new", Some(id)) => reply(&mut output, id, json!({"sessionId": SESSION_ID}))?,
            ("session/prompt", Some(id)) => run_prompt(scenario, id, &mut lines, &mut output)?,
            ("session/cancel", None) => {}
            (_, Some(id)) => reply_error(&mut output, id, -32601, "method not found")?,
            (_, None) => {}
        }
    }

    Ok(())
}

fn run_prompt(
    scenario: Scenario,
    prompt_id: Value,
    lines: &mut impl Iterator<Item = io::Result<String>>,
    output: &mut impl Write,
) -> io::Result<()> {
    match scenario {
        Scenario::Happy => happy_prompt(output, prompt_id),
        Scenario::PollutedStdout => {
            writeln!(output, "not-json")?;
            output.flush()?;
            happy_prompt(output, prompt_id)
        }
        Scenario::JsonObjectStdout => {
            writeln!(output, "{{\"message\":\"starting\"}}")?;
            output.flush()?;
            happy_prompt(output, prompt_id)
        }
        Scenario::Permission => permission_prompt(lines, output, prompt_id),
        Scenario::Cancel => cancel_prompt(lines, output, prompt_id),
        Scenario::ToolFailed => tool_failed_prompt(output, prompt_id),
        Scenario::ExitMidPrompt => process::exit(23),
        Scenario::QueuedUpdatesThenExit => {
            for _ in 0..2_000 {
                session_update(
                    output,
                    json!({
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "late"}
                    }),
                )?;
            }
            process::exit(24)
        }
        Scenario::UnknownNotification => {
            session_update(
                output,
                json!({"sessionUpdate": "future_update", "detail": "fake extension"}),
            )?;
            end_turn(output, prompt_id, "end_turn")
        }
        Scenario::UnknownMethod => {
            notification(
                output,
                "future/event",
                json!({"sessionId": SESSION_ID, "detail": "future"}),
            )?;
            end_turn(output, prompt_id, "end_turn")
        }
        Scenario::InvalidUpdate => {
            session_update(
                output,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text"}
                }),
            )?;
            end_turn(output, prompt_id, "end_turn")
        }
        Scenario::InvalidUpdateNoTerminal => session_update(
            output,
            json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text"}
            }),
        ),
        Scenario::LongUtf8ToolResult => {
            session_update(
                output,
                json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": TOOL_CALL_ID,
                    "status": "completed",
                    "rawOutput": {"result": "界".repeat(22_000)}
                }),
            )?;
            end_turn(output, prompt_id, "end_turn")
        }
        Scenario::ProcessContext | Scenario::InitializeFailed | Scenario::SessionNewHang => {
            end_turn(output, prompt_id, "end_turn")
        }
        Scenario::StderrExit => unreachable!(),
    }
}

fn happy_prompt(output: &mut impl Write, prompt_id: Value) -> io::Result<()> {
    session_update(output, content_update("agent_thought_chunk", "正在思考"))?;
    session_update(output, content_update("agent_message_chunk", "你"))?;
    session_update(output, content_update("agent_message_chunk", "好"))?;
    session_update(output, tool_started())?;
    session_update(
        output,
        json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": TOOL_CALL_ID,
            "status": "completed",
            "rawOutput": {"result": "工具调用成功"}
        }),
    )?;
    end_turn(output, prompt_id, "end_turn")
}

fn permission_prompt(
    lines: &mut impl Iterator<Item = io::Result<String>>,
    output: &mut impl Write,
    prompt_id: Value,
) -> io::Result<()> {
    write_json_line(
        output,
        &json!({
            "jsonrpc": "2.0",
            "id": "permission-rpc-1",
            "method": "session/request_permission",
            "params": {
                "sessionId": SESSION_ID,
                "toolCall": {
                    "toolCallId": TOOL_CALL_ID,
                    "title": "运行 fake 工具",
                    "kind": "execute",
                    "status": "pending"
                },
                "options": [
                    {"optionId": "allow-once", "name": "允许一次", "kind": "allow_once"},
                    {"optionId": "reject-once", "name": "拒绝一次", "kind": "reject_once"}
                ]
            }
        }),
    )?;

    for line in lines {
        let line = line?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            reply_error(output, Value::Null, -32700, "parse error")?;
            continue;
        };
        if let Some(option_id) = selected_permission_option(&message) {
            return reply(
                output,
                prompt_id,
                json!({
                    "stopReason": "end_turn",
                    "_meta": {"permissionDecision": option_id}
                }),
            );
        }
    }

    Ok(())
}

fn selected_permission_option(message: &Value) -> Option<&str> {
    if message.get("jsonrpc") != Some(&json!("2.0"))
        || message.get("id") != Some(&json!("permission-rpc-1"))
        || message.get("method").is_some()
        || message.get("error").is_some()
        || message.pointer("/result/outcome/outcome") != Some(&json!("selected"))
    {
        return None;
    }

    match message
        .pointer("/result/outcome/optionId")
        .and_then(Value::as_str)
    {
        Some(option_id @ ("allow-once" | "reject-once")) => Some(option_id),
        _ => None,
    }
}

fn cancel_prompt(
    lines: &mut impl Iterator<Item = io::Result<String>>,
    output: &mut impl Write,
    prompt_id: Value,
) -> io::Result<()> {
    for line in lines {
        let line = line?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            reply_error(output, Value::Null, -32700, "parse error")?;
            continue;
        };
        if message.get("id").is_none()
            && message.get("method") == Some(&json!("session/cancel"))
            && message.pointer("/params/sessionId") == Some(&json!(SESSION_ID))
        {
            return end_turn(output, prompt_id, "cancelled");
        }
    }

    Ok(())
}

fn tool_failed_prompt(output: &mut impl Write, prompt_id: Value) -> io::Result<()> {
    session_update(output, tool_started())?;
    session_update(
        output,
        json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": TOOL_CALL_ID,
            "status": "failed",
            "rawOutput": {"error": "fake tool failure"}
        }),
    )?;
    end_turn(output, prompt_id, "end_turn")
}

fn content_update(kind: &str, text: &str) -> Value {
    json!({
        "sessionUpdate": kind,
        "content": {"type": "text", "text": text}
    })
}

fn tool_started() -> Value {
    json!({
        "sessionUpdate": "tool_call",
        "toolCallId": TOOL_CALL_ID,
        "title": "fake 搜索工具",
        "kind": "search",
        "status": "in_progress",
        "rawInput": {"query": "最新消息"}
    })
}

fn session_update(output: &mut impl Write, update: Value) -> io::Result<()> {
    write_json_line(
        output,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": SESSION_ID, "update": update}
        }),
    )
}

fn notification(output: &mut impl Write, method: &str, params: Value) -> io::Result<()> {
    write_json_line(
        output,
        &json!({"jsonrpc": "2.0", "method": method, "params": params}),
    )
}

fn end_turn(output: &mut impl Write, id: Value, stop_reason: &str) -> io::Result<()> {
    reply(output, id, json!({"stopReason": stop_reason}))
}

fn reply(output: &mut impl Write, id: Value, result: Value) -> io::Result<()> {
    write_json_line(
        output,
        &json!({"jsonrpc": "2.0", "id": id, "result": result}),
    )
}

fn reply_error(output: &mut impl Write, id: Value, code: i64, message: &str) -> io::Result<()> {
    let mut error = Map::new();
    error.insert("code".to_string(), json!(code));
    error.insert("message".to_string(), json!(message));
    write_json_line(output, &json!({"jsonrpc": "2.0", "id": id, "error": error}))
}

fn write_json_line(output: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}
