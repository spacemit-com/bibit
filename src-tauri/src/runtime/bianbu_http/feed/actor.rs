use super::*;
use futures_util::SinkExt;
use tokio::task::{AbortHandle, JoinSet};
use tokio_util::sync::CancellationToken;

const MAX_SESSIONS: usize = 256;
const MAX_RECOVERIES: usize = 4;
const PING_INTERVAL: Duration = Duration::from_secs(15);
const PONG_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Copy)]
pub(super) struct InitialTicket {
    generation: Option<u64>,
}

pub(super) enum Command {
    Inspect {
        session: String,
        reply: oneshot::Sender<InitialTicket>,
    },
    Initial {
        session: String,
        ticket: InitialTicket,
        end: Option<u64>,
        latest: bool,
        reply: oneshot::Sender<Result<String, RuntimeError>>,
    },
    Start {
        output: mpsc::Sender<SessionFeedEvent>,
        cancel: CancellationToken,
        reply: oneshot::Sender<()>,
    },
    #[cfg(test)]
    Snapshot {
        reply: oneshot::Sender<HashMap<String, (Option<u64>, bool)>>,
    },
    #[cfg(test)]
    Diagnostics { reply: oneshot::Sender<Value> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RecoveryStamp {
    epoch: u64,
    connection: u64,
    session: String,
    generation: u64,
    request: u64,
}

struct SessionState {
    cursor: Option<u64>,
    generation: u64,
    paused: bool,
    pending: bool,
    gap: Option<u64>,
    retry_at: Instant,
    recovery: Option<(RecoveryStamp, AbortHandle)>,
}

enum Update {
    Socket {
        epoch: u64,
        name: &'static str,
        connection: u64,
        event: SocketEvent,
    },
    Page {
        stamp: RecoveryStamp,
        event: SessionFeedEvent,
        reply: oneshot::Sender<bool>,
    },
}

enum SocketEvent {
    Open,
    Frame(Value),
    Closed(RuntimeError),
}

pub(super) struct FeedActor {
    reader: PageReader,
    live: broadcast::Sender<(String, Vec<Value>)>,
    sessions: HashMap<String, SessionState>,
    serial: u64,
    epoch: u64,
    connections: HashMap<&'static str, u64>,
    ready: HashSet<&'static str>,
    failed: bool,
    output: Option<mpsc::Sender<SessionFeedEvent>>,
    cancel: CancellationToken,
    sockets: JoinSet<()>,
    recoveries: JoinSet<(RecoveryStamp, Result<Option<u64>, RuntimeError>)>,
    updates: mpsc::Sender<Update>,
    inbox: mpsc::Receiver<Update>,
    overloaded: bool,
    #[cfg(test)]
    counters: HashMap<&'static str, u64>,
}

impl FeedActor {
    pub(super) fn new(reader: PageReader, live: broadcast::Sender<(String, Vec<Value>)>) -> Self {
        let (updates, inbox) = mpsc::channel(64);
        Self {
            reader,
            live,
            sessions: HashMap::new(),
            serial: 0,
            epoch: 0,
            connections: HashMap::new(),
            ready: HashSet::new(),
            failed: false,
            output: None,
            cancel: CancellationToken::new(),
            sockets: JoinSet::new(),
            recoveries: JoinSet::new(),
            updates,
            inbox,
            overloaded: false,
            #[cfg(test)]
            counters: HashMap::new(),
        }
    }

    /// 测试用的行为计数：定位「为什么没有补读」这类问题时，比推断可靠。
    #[cfg(test)]
    fn count(&mut self, name: &'static str) {
        *self.counters.entry(name).or_default() += 1;
    }
    #[cfg(not(test))]
    fn count(&mut self, _name: &'static str) {}

    fn next_serial(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }

    fn status(&self) -> &'static str {
        if self.failed {
            "disconnected"
        } else if self.ready.len() == 2 {
            "connected"
        } else {
            "reconnecting"
        }
    }

    fn open(&mut self, session: &str) -> Result<&mut SessionState, RuntimeError> {
        if !self.sessions.contains_key(session) {
            if self.sessions.len() == MAX_SESSIONS {
                return Err(runtime_error("打开会话超过 256 个，请关闭部分会话后重试"));
            }
            let generation = self.next_serial();
            self.sessions.insert(
                session.into(),
                SessionState {
                    cursor: None,
                    generation,
                    paused: false,
                    pending: false,
                    gap: None,
                    retry_at: Instant::now(),
                    recovery: None,
                },
            );
        }
        Ok(self.sessions.get_mut(session).unwrap())
    }

    fn stop_io(&mut self) {
        self.epoch += 1;
        self.sockets.abort_all();
        self.recoveries.abort_all();
        self.connections.clear();
        self.ready.clear();
        for state in self.sessions.values_mut() {
            state.recovery = None;
            state.pending = !state.paused;
            state.retry_at = Instant::now();
        }
    }

    fn start_sockets(&mut self) {
        for name in ["mux", "host"] {
            let reader = self.reader.clone();
            let updates = self.updates.clone();
            let epoch = self.epoch;
            self.sockets.spawn(async move {
                socket(reader, updates, epoch, name, PING_INTERVAL, PONG_TIMEOUT).await
            });
        }
    }

    fn emit(&mut self, event: SessionFeedEvent) -> bool {
        let Some(output) = self.output.as_ref() else {
            return false;
        };
        match output.try_send(event) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.shed();
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.count("emit_closed");
                self.stop_io();
                self.output = None;
                self.cancel.cancel();
                false
            }
        }
    }

    /// 下游满了就**丢帧并标记待恢复**，而不是重建连接：mux 是健康的（它还在正常回 pong），
    /// 慢的只是消费端。游标停在最后一帧已确认投递的位置，容量回来后再从那里补读，
    /// 因此既不丢内容，也不会让健康连接陷入「满了就重连」的风暴。
    fn shed(&mut self) {
        self.count("shed");
        self.overloaded = true;
        self.recoveries.abort_all();
        for state in self.sessions.values_mut() {
            state.recovery = None;
            state.pending = !state.paused;
            state.retry_at = Instant::now();
        }
    }

    fn connection_event(&mut self, session: &str, message: Option<String>) {
        let mut event = self.reader.event(session, "connection");
        event.connection_status = self.status().into();
        event.message = message;
        self.emit(event);
    }

    fn deleted(&mut self, session: &str) {
        if let Some(state) = self.sessions.remove(session) {
            if let Some((_, task)) = state.recovery {
                task.abort();
            }
        }
        let mut event = self.reader.event(session, "connection");
        event.connection_status = "disconnected".into();
        event.message = Some("会话已删除".into());
        self.emit(event);
    }

    fn session_failure(&mut self, session: &str, error: RuntimeError) {
        if session_not_found(&error) {
            self.deleted(session);
            return;
        }
        if let Some(state) = self.sessions.get_mut(session) {
            state.paused = !error.recoverable;
            state.pending = error.recoverable;
            state.retry_at = Instant::now() + Duration::from_secs(5);
        }
        let mut event = self.reader.event(session, "connection");
        event.connection_status = if error.recoverable {
            "reconnecting"
        } else {
            "disconnected"
        }
        .into();
        event.message = Some(if error.recoverable {
            format!("{}；正在重试恢复此会话", error.message)
        } else {
            format!("{}；此会话已暂停，请重新加载会话", error.message)
        });
        self.emit(event);
    }

    fn frame(&mut self, value: Value) -> Result<(), RuntimeError> {
        let kind = value["type"].as_str().unwrap_or("");
        let session = value["session_id"].as_str().unwrap_or("");
        if !matches!(
            kind,
            "host/sessions" | "session/subscribed" | "session/unsubscribed" | "session/event"
        ) {
            return Err(protocol_error("WebSocket 帧协议不兼容"));
        }
        if kind == "host/sessions" {
            if !value["sessions"].is_array() {
                return Err(protocol_error("Host 帧缺少会话数组"));
            }
            let mut event = self.reader.event("", "summary");
            event.summary = Some(value);
            self.emit(event);
            return Ok(());
        }
        if session.is_empty() {
            return Err(protocol_error("WebSocket 帧缺少 session_id"));
        }
        if kind == "session/unsubscribed" {
            self.deleted(session);
            return Ok(());
        }
        if self.sessions.get(session).is_some_and(|state| state.paused) {
            return Ok(());
        }
        if kind == "session/subscribed" {
            if let Some(state) = self.sessions.get_mut(session) {
                state.pending = true;
            }
            return Ok(());
        }
        let item = bound_event(value["event"].clone())?;
        let next = seq(&item).ok_or_else(|| protocol_error("实时事件缺少 seq"))?;
        // Run 级订阅消费的是原始实时帧，与 Session 游标的连续性无关：即使这个会话正在补洞，
        // 也要立刻广播出去，否则 Run 事件流会被会话级对账拖住（消费者按 seq 自行去重）。
        let _ = self.live.send((session.to_owned(), vec![item.clone()]));
        let state = self.open(session)?;
        if state.cursor.is_some_and(|cursor| next <= cursor) {
            return Ok(());
        }
        if state
            .cursor
            .is_some_and(|cursor| next != cursor.saturating_add(1))
        {
            state.gap = Some(state.gap.map_or(next, |gap| gap.max(next)));
            state.pending = true;
            return Ok(());
        }
        let mut event = self.reader.event(session, "events");
        event.events.push(item);
        self.deliver(event);
        Ok(())
    }

    fn deliver(&mut self, mut event: SessionFeedEvent) -> bool {
        let Some(state) = self.sessions.get(&event.session_id) else {
            self.count("deliver_no_session");
            return false;
        };
        event.events.retain(|item| {
            seq(item).is_some_and(|next| state.cursor.is_none_or(|cursor| next > cursor))
        });
        // 空的**数据帧**没有可投递的内容，丢掉即可；但 reset 是控制信号（尾部回退时
        // 通知订阅方丢掉旧窗口重装），它本来就是空事件帧，不能被这条规则吞掉。
        if event.events.is_empty() && event.kind != "reset" {
            return true;
        }
        let end = event.events.last().and_then(seq);
        let session = event.session_id.clone();
        if !self.emit(event) {
            return false;
        }
        self.count("deliver");
        if let Some(end) = end {
            let state = self.sessions.get_mut(&session).unwrap();
            state.cursor = Some(end);
            if state.gap.is_some_and(|gap| end >= gap) {
                state.gap = None;
            }
        }
        true
    }

    fn matches(&self, stamp: &RecoveryStamp) -> bool {
        self.epoch == stamp.epoch
            && self.connections.get("mux") == Some(&stamp.connection)
            && self.sessions.get(&stamp.session).is_some_and(|state| {
                state.generation == stamp.generation
                    && !state.paused
                    && state
                        .recovery
                        .as_ref()
                        .is_some_and(|(active, _)| active == stamp)
            })
    }

    fn recover_pending(&mut self) {
        if self.overloaded || self.output.is_none() {
            return;
        }
        let Some(connection) = self.connections.get("mux").copied() else {
            self.count("no_mux");
            return;
        };
        let available = MAX_RECOVERIES.saturating_sub(
            self.sessions
                .values()
                .filter(|state| state.recovery.is_some())
                .count(),
        );
        let pending: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, state)| {
                state.pending
                    && !state.paused
                    && state.recovery.is_none()
                    && state.retry_at <= Instant::now()
            })
            .take(available)
            .map(|(session, _)| session.clone())
            .collect();
        for session in pending {
            let request = self.next_serial();
            let state = self.sessions.get_mut(&session).unwrap();
            let stamp = RecoveryStamp {
                epoch: self.epoch,
                connection,
                session,
                generation: state.generation,
                request,
            };
            let reader = self.reader.clone();
            let updates = self.updates.clone();
            let cursor = state.cursor;
            let identity = stamp.clone();
            let task = self.recoveries.spawn(async move {
                let result = tokio::time::timeout(
                    RECOVERY_TIMEOUT,
                    recovery(reader, updates, identity.clone(), cursor),
                )
                .await
                .unwrap_or_else(|_| Err(runtime_error("会话恢复超时")));
                (identity, result)
            });
            state.pending = false;
            state.recovery = Some((stamp, task));
            self.count("recover_spawn");
        }
    }

    fn handle_command(&mut self, command: Command) {
        match command {
            Command::Inspect { session, reply } => {
                let _ = reply.send(InitialTicket {
                    generation: self.sessions.get(&session).map(|state| state.generation),
                });
            }
            Command::Initial {
                session,
                ticket,
                end,
                latest,
                reply,
            } => {
                if reply.is_closed() {
                    return;
                }
                let current = self.sessions.get(&session).map(|state| state.generation);
                // 只按**这个会话**的代次判定。用全局删除计数会让「打开 A 会话时删掉了 B 会话」
                // 这类无关操作误判成「读取期间会话已改变」，把一次本来成功的窗口读变成报错；
                // 而删掉再重建会拿到新代次、直接删除会让 current 变成 None，两种情况都已覆盖。
                let valid = ticket
                    .generation
                    .is_none_or(|generation| current == Some(generation));
                if !valid {
                    let _ = reply.send(Err(runtime_error("会话在读取期间已改变，请重新加载")));
                    return;
                }
                if latest {
                    let generation = self.next_serial();
                    match self.open(&session) {
                        Ok(state) => {
                            if let Some((_, task)) = state.recovery.take() {
                                task.abort();
                            }
                            state.generation = generation;
                            state.paused = false;
                            if state.cursor.is_none() {
                                state.cursor = end;
                            }
                            state.pending = state.gap.is_some();
                            state.retry_at = Instant::now();
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                            return;
                        }
                    }
                }
                let _ = reply.send(Ok(self.status().into()));
            }
            Command::Start {
                output,
                cancel,
                reply,
            } => {
                if reply.is_closed() || cancel.is_cancelled() {
                    return;
                }
                self.cancel.cancel();
                self.stop_io();
                self.cancel = cancel;
                self.output = Some(output);
                self.failed = false;
                self.overloaded = false;
                self.start_sockets();
                let _ = reply.send(());
            }
            #[cfg(test)]
            Command::Snapshot { reply } => {
                let _ = reply.send(
                    self.sessions
                        .iter()
                        .map(|(session, state)| (session.clone(), (state.cursor, state.paused)))
                        .collect(),
                );
            }
            #[cfg(test)]
            Command::Diagnostics { reply } => {
                let sessions = self
                    .sessions
                    .iter()
                    .map(|(session, state)| {
                        (
                            session.clone(),
                            json!({
                                "cursor": state.cursor,
                                "paused": state.paused,
                                "pending": state.pending,
                                "gap": state.gap,
                                "recovering": state.recovery.is_some(),
                                "generation": state.generation,
                            }),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>();
                let _ = reply.send(json!({
                    "overloaded": self.overloaded,
                    "epoch": self.epoch,
                    "connections": self.connections,
                    "recoveries": self.recoveries.len(),
                    "output": self.output.is_some(),
                    "failed": self.failed,
                    "counters": self.counters.iter().map(|(name, count)| (name.to_string(), json!(count))).collect::<serde_json::Map<_, _>>(),
                    "sessions": sessions,
                }));
            }
        }
    }

    fn handle_update(&mut self, update: Update) {
        match update {
            Update::Page {
                stamp,
                event,
                reply,
            } => {
                let session = event.session_id.clone();
                let batch = event.events.clone();
                let accepted = self.matches(&stamp) && self.deliver(event);
                if accepted && !batch.is_empty() {
                    let _ = self.live.send((session, batch));
                }
                let _ = reply.send(accepted);
            }
            Update::Socket {
                epoch,
                name,
                connection,
                event,
            } => {
                if epoch != self.epoch {
                    return;
                }
                match event {
                    SocketEvent::Closed(error) => {
                        self.count("closed");
                        self.connections.remove(name);
                        self.ready.remove(name);
                        if name == "mux" {
                            self.recoveries.abort_all();
                            for state in self.sessions.values_mut() {
                                state.recovery = None;
                                state.pending = !state.paused;
                            }
                        }
                        self.failed |= !error.recoverable;
                        self.connection_event("", Some(error.message));
                    }
                    // 过载期间只丢数据帧，连接的生死仍然照常记账（上面的 Closed 分支）。
                    _ if self.overloaded || self.output.is_none() => {
                        self.count("shed_frame");
                    }
                    SocketEvent::Open => {
                        self.count("open");
                        self.connections.insert(name, connection);
                        if name == "mux" {
                            self.ready.insert(name);
                            for state in self.sessions.values_mut() {
                                state.pending = !state.paused;
                            }
                            self.connection_event("", None);
                        }
                    }
                    SocketEvent::Frame(value) => {
                        self.count("frame");
                        if self.connections.get(name) != Some(&connection) {
                            self.count("stale_frame");
                            return;
                        }
                        let scoped = matches!(
                            value["type"].as_str(),
                            Some("session/event" | "session/subscribed")
                        );
                        let session = value["session_id"].as_str().unwrap_or("").to_owned();
                        let host_ready = name == "host" && value["type"] == "host/sessions";
                        match self.frame(value) {
                            Err(error) if scoped => self.session_failure(&session, error),
                            Err(error) => {
                                self.stop_io();
                                self.failed = true;
                                self.connection_event("", Some(error.message));
                            }
                            Ok(()) if host_ready && self.epoch == epoch => {
                                self.ready.insert("host");
                                self.connection_event("", None);
                            }
                            Ok(()) => {}
                        }
                    }
                }
            }
        }
    }

    pub(super) async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        loop {
            self.recover_pending();
            let output = self.output.clone();
            tokio::select! {
                command = commands.recv() => match command {
                    Some(command) => self.handle_command(command),
                    None => return,
                },
                _ = self.cancel.cancelled(), if self.output.is_some() => {
                    self.stop_io();
                    self.output = None;
                    self.overloaded = false;
                }
                _ = async { output.as_ref().unwrap().closed().await }, if output.is_some() => {
                    self.stop_io();
                    self.output = None;
                    self.cancel.cancel();
                }
                permit = async { output.as_ref().unwrap().reserve().await }, if self.overloaded && output.is_some() => {
                    if let Ok(permit) = permit {
                        // 只放开闸门，不在这里发提示帧：这里唯一一个空槽必须留给真正的数据帧，
                        // 否则「提示帧抢槽 → 数据帧再失败 → 再提示」会变成饥饿活锁，用户永远
                        // 只看到状态闪烁而收不到内容。恢复完成时会照常发本会话的 connection 帧。
                        drop(permit);
                        self.count("clear");
                        self.overloaded = false;
                    }
                }
                update = self.inbox.recv() => if let Some(update) = update { self.handle_update(update); },
                result = self.recoveries.join_next(), if !self.recoveries.is_empty() => {
                    if result.as_ref().is_some_and(|result| result.as_ref().is_err_and(|error| error.is_panic())) {
                        self.stop_io();
                        self.overloaded = true;
                    }
                    if let Some(Ok((stamp, result))) = result {
                        if self.matches(&stamp) {
                            self.count("recover_done");
                            let state = self.sessions.get_mut(&stamp.session).unwrap();
                            state.recovery = None;
                            state.pending |= state.gap.is_some();
                            state.retry_at = Instant::now() + Duration::from_millis(250);
                            match result {
                                Ok(_) => self.connection_event(&stamp.session, None),
                                Err(error) => self.session_failure(&stamp.session, error),
                            }
                        }
                    }
                }
                result = self.sockets.join_next(), if !self.sockets.is_empty() => {
                    if result.is_some_and(|result| result.is_err_and(|error| error.is_panic())) {
                        self.stop_io();
                        self.overloaded = true;
                    }
                }
                _ = ticker.tick() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn actor() -> (FeedActor, mpsc::Receiver<SessionFeedEvent>) {
        let hub = FeedHub::new(
            Client::new(),
            Arc::new(Url::parse("http://127.0.0.1:9/api/v1/").unwrap()),
            "target".into(),
        );
        let mut actor = FeedActor::new(hub.reader.clone(), hub.live.clone());
        let (output, receiver) = mpsc::channel(16);
        actor.output = Some(output);
        actor.connections.insert("mux", 1);
        (actor, receiver)
    }

    fn frame(session: &str, sequence: u64) -> Value {
        json!({"type":"session/event","session_id":session,"event":{"seq":sequence,"type":"assistant/text.delta","data":{"text":"x"}}})
    }

    #[tokio::test]
    async fn output_backpressure_never_advances_the_cursor_and_keeps_control_available() {
        let (mut actor, _) = actor();
        let (output, mut receiver) = mpsc::channel(1);
        actor.output = Some(output);
        actor.frame(frame("session", 0)).unwrap();
        actor.frame(frame("session", 1)).unwrap();
        assert!(actor.overloaded);
        assert_eq!(actor.sessions["session"].cursor, Some(0));
        assert_eq!(receiver.recv().await.unwrap().events[0]["seq"], 0);
        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Inspect {
            session: "session".into(),
            reply,
        });
        assert!(result.await.unwrap().generation.is_some());
        assert!(actor.sessions["session"].pending);
    }

    #[tokio::test]
    async fn a_tail_rewind_reset_frame_reaches_the_consumer() {
        // 尾部回退是空事件帧，但它是控制信号：必须真的到订阅方，否则界面不会重装窗口。
        let (mut actor, mut output) = actor();
        actor.open("session").unwrap();
        assert!(actor.deliver(actor.reader.event("session", "reset")));
        assert_eq!(output.recv().await.unwrap().kind, "reset");
        // 空的数据帧照旧不发。
        assert!(actor.deliver(actor.reader.event("session", "events")));
        assert!(output.try_recv().is_err());
    }

    #[tokio::test]
    async fn deleted_then_reopened_session_rejects_old_recovery_and_initial_results() {
        let (mut actor, mut output) = actor();
        let state = actor.open("session").unwrap();
        state.cursor = Some(0);
        let stamp = RecoveryStamp {
            epoch: 0,
            connection: 1,
            session: "session".into(),
            generation: state.generation,
            request: 3,
        };
        let ticket = InitialTicket {
            generation: Some(state.generation),
        };
        actor.deleted("session");
        actor.frame(frame("session", 10)).unwrap();
        let mut event = actor.reader.event("session", "events");
        event.events.push(json!({"seq":99}));
        let (reply, accepted) = oneshot::channel();
        actor.handle_update(Update::Page {
            stamp,
            event,
            reply,
        });
        assert!(!accepted.await.unwrap());
        assert_eq!(actor.sessions["session"].cursor, Some(10));
        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Initial {
            session: "session".into(),
            ticket,
            end: Some(99),
            latest: true,
            reply,
        });
        assert!(result.await.unwrap().is_err());
        assert_eq!(
            output.recv().await.unwrap().message.as_deref(),
            Some("会话已删除")
        );
        assert_eq!(output.recv().await.unwrap().events[0]["seq"], 10);
        assert!(output.try_recv().is_err());
    }

    #[tokio::test]
    async fn anchor_and_gap_are_preserved_without_opening_unsubscribed_sessions() {
        let (mut actor, mut output) = actor();
        actor
            .frame(json!({"type":"session/subscribed","session_id":"session"}))
            .unwrap();
        assert!(actor.sessions.is_empty());
        actor.frame(frame("session", 0)).unwrap();
        actor.frame(frame("session", 3)).unwrap();
        assert_eq!(actor.sessions["session"].cursor, Some(0));
        assert_eq!(actor.sessions["session"].gap, Some(3));
        assert!(actor.sessions["session"].pending);
        assert_eq!(output.recv().await.unwrap().events[0]["seq"], 0);
        assert!(output.try_recv().is_err());
        actor
            .frame(json!({"type":"session/unsubscribed","session_id":"session"}))
            .unwrap();
        assert!(actor.sessions.is_empty());
    }

    #[tokio::test]
    async fn slow_recovery_does_not_block_other_sessions_control_or_realtime() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!(
            "http://{}/api/v1/",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let (release, wait) = oneshot::channel::<()>();
        let (started, started_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut wait = Some(wait);
            let mut started = Some(started);
            let mut requests = JoinSet::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).await.unwrap();
                let slow = String::from_utf8_lossy(&request[..count]).contains("/slow/");
                let wait = if slow { wait.take() } else { None };
                let started = if slow { started.take() } else { None };
                requests.spawn(async move {
                    if let Some(started) = started { let _ = started.send(()); }
                    if let Some(wait) = wait { let _ = wait.await; }
                    let body = r#"{"data":[{"seq":1,"type":"assistant/text.delta"}],"last_seq":1,"has_more":false}"#;
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
                });
            }
            while let Some(result) = requests.join_next().await {
                result.unwrap();
            }
        });
        let (mut actor, mut output) = actor();
        actor.reader.base = Arc::new(base);
        for session in ["slow", "fast"] {
            let state = actor.open(session).unwrap();
            state.cursor = Some(0);
            state.pending = true;
        }
        let updates = actor.updates.clone();
        let (commands, inbox) = mpsc::channel(8);
        let task = tokio::spawn(actor.run(inbox));
        tokio::time::timeout(Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = output.recv().await.unwrap();
                if event.session_id == "fast" && !event.events.is_empty() {
                    break;
                }
            }
        })
        .await
        .unwrap();
        for sequence in 1..=9 {
            updates
                .send(Update::Socket {
                    epoch: 0,
                    name: "mux",
                    connection: 1,
                    event: SocketEvent::Frame(frame("slow", sequence)),
                })
                .await
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = output.recv().await.unwrap();
                if event.events.last().and_then(seq) == Some(9) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        release.send(()).unwrap();
        server.await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = output.recv().await.unwrap();
                if event.session_id == "slow" && event.kind == "connection" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let (reply, result) = oneshot::channel();
        commands.send(Command::Snapshot { reply }).await.unwrap();
        assert_eq!(result.await.unwrap()["slow"].0, Some(9));
        drop(commands);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
    }

    /// 会话被 Runtime 删除时，只该判这一个会话失效：其余会话的游标与恢复状态都不能动。
    /// 这条路径原先内联在 `FeedHub::recover` 里，改成 actor 之后必须仍然成立。
    #[tokio::test]
    async fn a_not_found_recovery_removes_only_that_session() {
        let (mut actor, mut output) = actor();
        for session in ["gone", "kept"] {
            actor.open(session).unwrap().cursor = Some(1);
        }
        let missing = http_error(
            reqwest::StatusCode::NOT_FOUND,
            &json!({"error": {"code": "session_not_found"}}),
            "读取事件失败",
        );
        actor.session_failure("gone", missing);
        assert!(!actor.sessions.contains_key("gone"));
        assert!(
            actor.sessions.contains_key("kept"),
            "别的会话不能被一起判死"
        );
        assert_eq!(
            actor.sessions.get("kept").unwrap().cursor,
            Some(1),
            "别的会话游标不能被动过"
        );
        let event = output.recv().await.unwrap();
        assert_eq!(event.session_id, "gone");
        assert_eq!(event.connection_status, "disconnected");
        assert_eq!(event.message.as_deref(), Some("会话已删除"));

        // 可恢复失败只让该会话回到重连队列，绝不能顺手把它删掉。
        actor.session_failure("kept", runtime_error("临时不可用"));
        let kept = actor.sessions.get("kept").unwrap();
        assert!(kept.pending && !kept.paused);
        let event = output.recv().await.unwrap();
        assert_eq!(event.connection_status, "reconnecting");
    }

    /// 打开 A 会话的窗口读期间，用户删掉了 B 会话：这不该让 A 的这次读失败。
    /// 早期实现用「全局删除计数」判定，会把无关删除当成「会话在读取期间已改变」而误报。
    #[tokio::test]
    async fn an_unrelated_deletion_does_not_invalidate_a_window_read() {
        let (mut actor, mut output) = actor();
        for session in ["mine", "other"] {
            actor.open(session).unwrap().cursor = Some(1);
        }
        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Inspect {
            session: "mine".into(),
            reply,
        });
        let ticket = result.await.unwrap();
        actor.deleted("other");
        assert_eq!(output.recv().await.unwrap().session_id, "other");

        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Initial {
            session: "mine".into(),
            ticket,
            end: Some(9),
            latest: true,
            reply,
        });
        assert!(
            result.await.unwrap().is_ok(),
            "无关会话被删除不该让这次窗口读失败"
        );
        assert_eq!(
            actor.sessions["mine"].cursor,
            Some(1),
            "已有游标不能被窗口水位覆盖"
        );

        // 对照组：同一个会话自己在读窗口期间被删掉，这次读必须被拒绝（否则会把已删会话复活）。
        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Inspect {
            session: "mine".into(),
            reply,
        });
        let ticket = result.await.unwrap();
        actor.deleted("mine");
        assert_eq!(output.recv().await.unwrap().session_id, "mine");
        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Initial {
            session: "mine".into(),
            ticket,
            end: Some(9),
            latest: true,
            reply,
        });
        assert!(result.await.unwrap().is_err(), "被删会话的窗口读必须被拒绝");
        assert!(!actor.sessions.contains_key("mine"));
    }

    /// 容量是硬上限：第 257 个会话必须显式报错，且失败的打开不能悄悄占位。
    #[tokio::test]
    async fn a_full_session_table_reports_capacity_and_reserves_no_room() {
        let (mut actor, _output) = actor();
        for index in 0..MAX_SESSIONS {
            actor.open(&format!("session-{index}")).unwrap();
        }
        assert_eq!(actor.sessions.len(), MAX_SESSIONS);

        let error = match actor.open("session-overflow") {
            Ok(_) => panic!("满载时不该还能打开新会话"),
            Err(error) => error,
        };
        assert!(error.message.contains("256"), "{}", error.message);
        assert_eq!(actor.sessions.len(), MAX_SESSIONS, "失败的打开不能占位");

        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Inspect {
            session: "session-overflow".into(),
            reply,
        });
        let ticket = result.await.unwrap();
        let (reply, result) = oneshot::channel();
        actor.handle_command(Command::Initial {
            session: "session-overflow".into(),
            ticket,
            end: Some(1),
            latest: true,
            reply,
        });
        assert!(result.await.unwrap().is_err(), "满载时打开必须显式失败");
        assert_eq!(actor.sessions.len(), MAX_SESSIONS);
    }
}

async fn recovery(
    reader: PageReader,
    updates: mpsc::Sender<Update>,
    stamp: RecoveryStamp,
    cursor: Option<u64>,
) -> Result<Option<u64>, RuntimeError> {
    let (pages, mut receiver) = mpsc::channel(1);
    let read = async {
        let result = reader.recover(&stamp.session, cursor, &pages).await;
        drop(pages);
        result
    };
    let forward = async {
        while let Some(event) = receiver.recv().await {
            let (reply, accepted) = oneshot::channel();
            updates
                .send(Update::Page {
                    stamp: stamp.clone(),
                    event,
                    reply,
                })
                .await
                .map_err(|_| runtime_error("事件管理任务已关闭"))?;
            if !accepted.await.unwrap_or(false) {
                return Err(runtime_error("恢复结果已失效"));
            }
        }
        Ok::<(), RuntimeError>(())
    };
    let (result, ()) = tokio::try_join!(read, forward)?;
    Ok(result)
}

async fn socket(
    reader: PageReader,
    updates: mpsc::Sender<Update>,
    epoch: u64,
    name: &'static str,
    ping_interval: Duration,
    pong_timeout: Duration,
) {
    let Ok(mut url) = reader.base.join(&format!("events/{name}")) else {
        return;
    };
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    if url.set_scheme(scheme).is_err() {
        return;
    }
    let mut connection = 0;
    let mut delay = Duration::from_millis(250);
    loop {
        connection += 1;
        let send = |event| Update::Socket {
            epoch,
            name,
            connection,
            event,
        };
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let attempt = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false),
        )
        .await;
        let error = match attempt {
            Ok(Ok((mut socket, _))) => {
                if updates.send(send(SocketEvent::Open)).await.is_err() {
                    return;
                }
                let mut heartbeat =
                    tokio::time::interval_at(Instant::now() + ping_interval, ping_interval);
                let mut pending_ping: Option<Instant> = None;
                let mut ping_sequence = 0u64;
                loop {
                    let frame = tokio::select! {
                        frame = socket.next() => frame,
                        _ = heartbeat.tick() => {
                            if pending_ping.is_some_and(|sent| sent.elapsed() >= pong_timeout) {
                                break runtime_error("WebSocket 心跳响应超时，正在重连");
                            }
                            if pending_ping.is_none() {
                                ping_sequence = ping_sequence.wrapping_add(1);
                                let payload = ping_sequence.to_be_bytes().to_vec();
                                let sent = Instant::now();
                                match tokio::time::timeout(CONTROL_TIMEOUT, socket.send(tokio_tungstenite::tungstenite::Message::Ping(payload.into()))).await {
                                    Ok(Ok(())) => pending_ping = Some(sent),
                                    _ => break runtime_error("WebSocket 心跳写入超时"),
                                }
                            }
                            continue;
                        }
                    };
                    match frame {
                        Some(Ok(frame)) if frame.is_text() => {
                            let value = match serde_json::from_slice::<Value>(&frame.into_data()) {
                                Ok(value) => value,
                                Err(_) => break protocol_error("WebSocket 协议不兼容"),
                            };
                            if updates.try_send(send(SocketEvent::Frame(value))).is_err() {
                                break runtime_error("WebSocket 事件积压，正在重新同步");
                            }
                            delay = Duration::from_millis(250);
                        }
                        Some(Ok(frame)) if frame.is_ping() => {
                            match tokio::time::timeout(CONTROL_TIMEOUT, socket.flush()).await {
                                Ok(Ok(())) => {}
                                _ => break runtime_error("WebSocket 心跳写入超时"),
                            }
                        }
                        Some(Ok(frame)) if frame.is_pong() => {
                            // 只把「收到 pong」当作活性证据：RFC 6455 要求回带同样的载荷，
                            // 但代理和部分实现会回空载荷。按载荷匹配会把健康连接判死，
                            // 那正是我们要修的病；载荷只用于日志，不参与判定。
                            pending_ping = None;
                        }
                        Some(Ok(frame)) if frame.is_close() => {
                            break runtime_error("WebSocket 已断开")
                        }
                        Some(Err(error)) => {
                            if name == "host"
                                && matches!(
                                    error,
                                    tokio_tungstenite::tungstenite::Error::Capacity(_)
                                )
                            {
                                break protocol_error(
                                    "Host 会话摘要超过 1 MiB，请减少会话数量后重连",
                                );
                            }
                            break runtime_error(error.to_string());
                        }
                        None => break runtime_error("WebSocket 已断开"),
                        _ => {}
                    }
                }
            }
            Ok(Err(error)) => {
                let permanent = matches!(&error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status().is_client_error() && ![408,429].contains(&response.status().as_u16()));
                let mut result = runtime_error(format!("{name} WebSocket: {error}"));
                result.recoverable = !permanent;
                result
            }
            Err(_) => runtime_error(format!("{name} WebSocket 握手超时（15 秒）")),
        };
        let permanent = !error.recoverable;
        if updates
            .send(send(SocketEvent::Closed(error)))
            .await
            .is_err()
            || permanent
        {
            return;
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(5));
    }
}
