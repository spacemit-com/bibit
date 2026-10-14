use super::{DemoRuntimeEvent, DemoRuntimeMode, DemoRuntimeRequest, DemoRuntimeService};
use clap::Parser;
use std::io::{self, IsTerminal, Read, Write};
#[cfg(test)]
use std::{
    io::{BufRead, BufReader},
    time::Duration,
};
use tokio::io::AsyncBufReadExt;

const EXIT_SUCCESS: i32 = 0;
const EXIT_RUNTIME_ERROR: i32 = 1;
const EXIT_INTERRUPTED: i32 = 130;

#[derive(Debug, Parser)]
#[command(name = "bibit", about = "BiBit 演示 Runtime 命令行入口")]
struct CliArgs {
    #[arg(long, value_enum, default_value_t = DemoRuntimeMode::Streaming)]
    mode: DemoRuntimeMode,
    #[arg(value_name = "PROMPT")]
    prompt: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PromptOutcome {
    Completed,
    Interrupted,
    Failed,
}

impl PromptOutcome {
    fn exit_code(self) -> i32 {
        match self {
            Self::Completed => EXIT_SUCCESS,
            Self::Interrupted => EXIT_INTERRUPTED,
            Self::Failed => EXIT_RUNTIME_ERROR,
        }
    }
}

fn write_error(error: &mut impl Write, message: impl std::fmt::Display) {
    let _ = writeln!(error, "错误：{message}");
    let _ = error.flush();
}

async fn execute_prompt(
    service: &DemoRuntimeService,
    prompt: &str,
    mode: DemoRuntimeMode,
    output: &mut impl Write,
    error: &mut impl Write,
    listen_for_interrupt: bool,
) -> PromptOutcome {
    let receiver = match service.start(DemoRuntimeRequest {
        session_id: format!("cli-{}", uuid::Uuid::new_v4()),
        prompt: prompt.to_owned(),
        mode,
    }) {
        Ok(receiver) => receiver,
        Err(runtime_error) => {
            write_error(error, runtime_error);
            return PromptOutcome::Failed;
        }
    };
    let run_id = receiver.run_id;
    let mut events = receiver.events;
    let mut wrote_stream_content = false;

    loop {
        let event = if listen_for_interrupt {
            tokio::select! {
                event = events.recv() => event,
                interrupt = tokio::signal::ctrl_c() => {
                    match interrupt {
                        Ok(()) => {
                            service.cancel(&run_id);
                            if wrote_stream_content {
                                let _ = writeln!(output);
                                let _ = output.flush();
                            }
                            return PromptOutcome::Interrupted;
                        }
                        Err(signal_error) => {
                            write_error(error, signal_error);
                            return PromptOutcome::Failed;
                        }
                    }
                }
            }
        } else {
            events.recv().await
        };

        match event {
            Some(DemoRuntimeEvent::RunStarted { .. }) => {}
            Some(DemoRuntimeEvent::MessageDelta { delta, .. }) => {
                if let Err(io_error) = output
                    .write_all(delta.as_bytes())
                    .and_then(|()| output.flush())
                {
                    service.cancel(&run_id);
                    write_error(error, io_error);
                    return PromptOutcome::Failed;
                }
                wrote_stream_content = true;
            }
            Some(DemoRuntimeEvent::MessageCompleted { content, .. }) => {
                let write_result = if mode == DemoRuntimeMode::Fixed {
                    writeln!(output, "{content}")
                } else if wrote_stream_content {
                    writeln!(output)
                } else {
                    writeln!(output, "{content}")
                };
                if let Err(io_error) = write_result.and_then(|()| output.flush()) {
                    write_error(error, io_error);
                    return PromptOutcome::Failed;
                }
                return PromptOutcome::Completed;
            }
            Some(DemoRuntimeEvent::RunCancelled { .. }) => {
                if wrote_stream_content {
                    let _ = writeln!(output);
                    let _ = output.flush();
                }
                return PromptOutcome::Interrupted;
            }
            Some(DemoRuntimeEvent::RunFailed { message, .. }) => {
                write_error(error, message);
                return PromptOutcome::Failed;
            }
            None => {
                write_error(error, "演示 Runtime 未返回结束事件");
                return PromptOutcome::Failed;
            }
        }
    }
}

fn build_runtime(error: &mut impl Write) -> Option<tokio::runtime::Runtime> {
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => Some(runtime),
        Err(runtime_error) => {
            write_error(error, runtime_error);
            None
        }
    }
}

fn parse_args<I, S>(args: I, error: &mut impl Write) -> Result<CliArgs, i32>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString> + Clone,
{
    CliArgs::try_parse_from(args).map_err(|parse_error| {
        let exit_code = parse_error.exit_code();
        let _ = write!(error, "{parse_error}");
        let _ = error.flush();
        exit_code
    })
}

#[cfg(test)]
fn run_with_io<I, S>(
    args: I,
    input: &mut impl Read,
    output: &mut impl Write,
    error: &mut impl Write,
    stdin_is_tty: bool,
    service: DemoRuntimeService,
) -> i32
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString> + Clone,
{
    let args = match parse_args(args, error) {
        Ok(args) => args,
        Err(exit_code) => return exit_code,
    };
    let Some(runtime) = build_runtime(error) else {
        return EXIT_RUNTIME_ERROR;
    };

    if !args.prompt.is_empty() {
        return runtime
            .block_on(execute_prompt(
                &service,
                &args.prompt.join(" "),
                args.mode,
                output,
                error,
                false,
            ))
            .exit_code();
    }

    if !stdin_is_tty {
        let mut prompt = String::new();
        if let Err(io_error) = input.read_to_string(&mut prompt) {
            write_error(error, io_error);
            return EXIT_RUNTIME_ERROR;
        }
        if prompt.trim().is_empty() {
            return EXIT_SUCCESS;
        }
        return runtime
            .block_on(execute_prompt(
                &service, &prompt, args.mode, output, error, false,
            ))
            .exit_code();
    }

    let mut input = BufReader::new(input);
    loop {
        if write!(output, "bibit> ")
            .and_then(|()| output.flush())
            .is_err()
        {
            return EXIT_RUNTIME_ERROR;
        }

        let mut line = String::new();
        match input.read_line(&mut line) {
            Ok(0) => return EXIT_SUCCESS,
            Ok(_) => {}
            Err(io_error) if io_error.kind() == io::ErrorKind::Interrupted => {
                return EXIT_INTERRUPTED;
            }
            Err(io_error) => {
                write_error(error, io_error);
                return EXIT_RUNTIME_ERROR;
            }
        }

        let prompt = line.trim();
        if prompt == "/exit" {
            return EXIT_SUCCESS;
        }
        if prompt.is_empty() {
            continue;
        }

        match runtime.block_on(execute_prompt(
            &service, prompt, args.mode, output, error, false,
        )) {
            PromptOutcome::Completed | PromptOutcome::Interrupted => {}
            PromptOutcome::Failed => return EXIT_RUNTIME_ERROR,
        }
    }
}

async fn run_interactive_stdio(
    mode: DemoRuntimeMode,
    service: &DemoRuntimeService,
    output: &mut impl Write,
    error: &mut impl Write,
) -> i32 {
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());

    loop {
        if write!(output, "bibit> ")
            .and_then(|()| output.flush())
            .is_err()
        {
            return EXIT_RUNTIME_ERROR;
        }

        let mut line = String::new();
        let read_result = tokio::select! {
            read_result = input.read_line(&mut line) => read_result,
            interrupt = tokio::signal::ctrl_c() => {
                return if interrupt.is_ok() {
                    EXIT_INTERRUPTED
                } else {
                    write_error(error, interrupt.unwrap_err());
                    EXIT_RUNTIME_ERROR
                };
            }
        };
        match read_result {
            Ok(0) => return EXIT_SUCCESS,
            Ok(_) => {}
            Err(io_error) => {
                write_error(error, io_error);
                return EXIT_RUNTIME_ERROR;
            }
        }

        let prompt = line.trim();
        if prompt == "/exit" {
            return EXIT_SUCCESS;
        }
        if prompt.is_empty() {
            continue;
        }

        match execute_prompt(service, prompt, mode, output, error, true).await {
            PromptOutcome::Completed | PromptOutcome::Interrupted => {}
            PromptOutcome::Failed => return EXIT_RUNTIME_ERROR,
        }
    }
}

pub fn run_cli_from_env() -> i32 {
    let mut args = std::env::args_os().collect::<Vec<_>>();
    if args.get(1).and_then(|arg| arg.to_str()) == Some("--cli") {
        args.remove(1);
    }

    let mut output = io::stdout();
    let mut error = io::stderr();
    let args = match parse_args(args, &mut error) {
        Ok(args) => args,
        Err(exit_code) => return exit_code,
    };
    let Some(runtime) = build_runtime(&mut error) else {
        return EXIT_RUNTIME_ERROR;
    };
    let service = DemoRuntimeService::default();

    if !args.prompt.is_empty() {
        return runtime
            .block_on(execute_prompt(
                &service,
                &args.prompt.join(" "),
                args.mode,
                &mut output,
                &mut error,
                true,
            ))
            .exit_code();
    }

    let mut input = io::stdin();
    if !input.is_terminal() {
        let mut prompt = String::new();
        if let Err(io_error) = input.read_to_string(&mut prompt) {
            write_error(&mut error, io_error);
            return EXIT_RUNTIME_ERROR;
        }
        if prompt.trim().is_empty() {
            return EXIT_SUCCESS;
        }
        return runtime
            .block_on(execute_prompt(
                &service,
                &prompt,
                args.mode,
                &mut output,
                &mut error,
                true,
            ))
            .exit_code();
    }

    runtime.block_on(run_interactive_stdio(
        args.mode,
        &service,
        &mut output,
        &mut error,
    ))
}

#[cfg(test)]
struct TestRun {
    code: i32,
    stdout: String,
    stderr: String,
}

#[cfg(test)]
fn run_for_test<I, S>(args: I, input: &str, stdin_is_tty: bool) -> TestRun
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString> + Clone,
{
    let mut input = io::Cursor::new(input.as_bytes());
    let mut output = Vec::new();
    let mut error = Vec::new();
    let code = run_with_io(
        args,
        &mut input,
        &mut output,
        &mut error,
        stdin_is_tty,
        DemoRuntimeService::new(Duration::ZERO),
    );

    TestRun {
        code,
        stdout: String::from_utf8(output).unwrap(),
        stderr: String::from_utf8(error).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::demo_runtime::DemoRuntimeMode;

    #[test]
    fn defaults_to_streaming_mode() {
        let args = CliArgs::try_parse_from(["bibit", "你好"]).unwrap();

        assert_eq!(args.mode, DemoRuntimeMode::Streaming);
    }

    #[test]
    fn parses_fixed_mode() {
        let args = CliArgs::try_parse_from(["bibit", "--mode", "fixed", "你好"]).unwrap();

        assert_eq!(args.mode, DemoRuntimeMode::Fixed);
    }

    #[test]
    fn fixed_and_streaming_have_the_same_final_text() {
        assert_eq!(
            answer(["bibit", "--mode", "fixed", "你好"], "", false),
            answer(["bibit", "--mode", "streaming", "你好"], "", false)
        );
    }

    #[test]
    fn invalid_mode_returns_usage_exit_code() {
        let result = run_for_test(["bibit", "--mode", "bad", "你好"], "", false);

        assert_eq!(result.code, 2);
        assert!(result.stderr.contains("invalid value"));
    }

    #[test]
    fn argument_prompt_takes_priority_over_piped_input() {
        let result = run_for_test(["bibit", "参数"], "管道", false);

        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("参数"));
        assert!(!result.stdout.contains("管道"));
    }

    #[test]
    fn non_tty_input_is_consumed_once() {
        let result = run_for_test(["bibit"], "管道输入\n", false);

        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.matches("已收到你的消息").count(), 1);
    }

    #[test]
    fn interactive_exit_does_not_start_a_run() {
        let result = run_for_test(["bibit"], "/exit\n", true);

        assert_eq!(result.code, 0);
        assert_eq!(result.stdout, "bibit> ");
    }

    #[test]
    fn interactive_blank_lines_are_skipped() {
        let result = run_for_test(["bibit"], "  \n你好\n/exit\n", true);

        assert_eq!(result.code, 0);
        assert_eq!(result.stdout.matches("已收到你的消息").count(), 1);
    }

    fn answer<I, S>(args: I, input: &str, stdin_is_tty: bool) -> String
    where
        I: IntoIterator<Item = S>,
        S: Into<std::ffi::OsString> + Clone,
    {
        run_for_test(args, input, stdin_is_tty).stdout
    }
}
