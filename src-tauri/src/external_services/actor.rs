use super::*;
use futures_util::{future::BoxFuture, stream::FuturesUnordered, StreamExt};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

const CONTROL_CAPACITY: usize = 16;
const EVENT_CAPACITY: usize = 32;
const CLEANUP_BUDGET: Duration = Duration::from_millis(300);
const NOTIFICATION_BUDGET: Duration = Duration::from_millis(100);
const QUEUED: u8 = 0;
const WRITING: u8 = 1;
const WRITTEN: u8 = 2;
const DISCARDED: u8 = 3;
const BROKEN: u8 = 4;

#[derive(Clone)]
pub(super) struct SessionInfo {
    pub protocol_version: u8,
    pub operations: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ProviderConfig {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub data_dir: PathBuf,
    pub protocol_versions: Vec<u8>,
}

#[derive(Clone)]
pub(super) struct ProviderHandle {
    requests: mpsc::Sender<PendingRequest>,
    controls: mpsc::Sender<PendingRequest>,
    capacity: Arc<Semaphore>,
    control_capacity: Arc<Semaphore>,
    ready: watch::Receiver<Option<Result<SessionInfo, &'static str>>>,
    stop: CancellationToken,
    pub done: CancellationToken,
    failure: Arc<OnceLock<&'static str>>,
}

struct PendingRequest {
    logical_id: String,
    method: &'static str,
    params: Value,
    deadline: Instant,
    cancellation: CancellationToken,
    completion: CancellationToken,
    phase: Arc<AtomicU8>,
    reply: oneshot::Sender<Result<JsonRpcResponse, String>>,
    _permit: OwnedSemaphorePermit,
}

impl PendingRequest {
    fn finish(self, result: Result<JsonRpcResponse, String>) {
        self.completion.cancel();
        let _ = self.reply.send(result);
    }
}

struct WriteFrame {
    id: String,
    bytes: Vec<u8>,
    deadline: Instant,
    phase: Arc<AtomicU8>,
}

enum IoEvent {
    Message(Value),
    Written,
    Failed(&'static str),
}

impl ProviderHandle {
    pub fn spawn(
        config: ProviderConfig,
        service_id: String,
        request_id: &str,
        deadline: Instant,
        cancellation: CancellationToken,
        jobs: Option<Arc<crate::feature_service_jobs::FeatureServiceJobRegistry>>,
        predecessor: Option<CancellationToken>,
    ) -> (Self, Option<Arc<ManagedV2Driver>>) {
        let (requests, request_rx) = mpsc::channel(MAX_PENDING_V2_REQUESTS);
        let (controls, control_rx) = mpsc::channel(CONTROL_CAPACITY);
        let (ready_tx, ready) = watch::channel(None);
        let handle = Self {
            requests,
            controls,
            capacity: Arc::new(Semaphore::new(MAX_PENDING_V2_REQUESTS)),
            control_capacity: Arc::new(Semaphore::new(CONTROL_CAPACITY)),
            ready,
            stop: CancellationToken::new(),
            done: CancellationToken::new(),
            failure: Arc::new(OnceLock::new()),
        };
        let driver = jobs.map(|jobs| {
            Arc::new(ManagedV2Driver {
                service_id: service_id.clone(),
                transport: handle.clone(),
                active_jobs: Mutex::new(BTreeSet::new()),
                provider_sequences: Mutex::new(BTreeMap::new()),
                cancel_waiters: Mutex::new(BTreeMap::new()),
                jobs,
            })
        });
        let (job_tx, job_rx) = mpsc::channel(EVENT_CAPACITY);
        if let Some(driver) = driver.as_ref() {
            tokio::spawn(run_job_events(Arc::clone(driver), job_rx));
        }
        let owner = ProviderOwner {
            stop: handle.stop.clone(),
            done: handle.done.clone(),
            failure: Arc::clone(&handle.failure),
            ready: ready_tx,
            requests: request_rx,
            controls: control_rx,
            jobs: driver.as_ref().map(|_| job_tx),
            pending: BTreeMap::new(),
            waiting: VecDeque::new(),
            notifications: VecDeque::new(),
            expirations: FuturesUnordered::new(),
            wire_prefix: format!("bibit:{}:", uuid::Uuid::new_v4()),
            next_id: 0,
            protocol_version: PROTOCOL_VERSION,
            serial_busy: None,
            writer_busy: false,
        };
        let initialize_id = format!("{request_id}:initialize");
        tokio::spawn(owner.run(
            config,
            service_id,
            initialize_id,
            deadline,
            cancellation,
            predecessor,
        ));
        (handle, driver)
    }

    pub fn healthy(&self) -> bool {
        !self.stop.is_cancelled()
    }

    pub fn request_stop(&self, code: &'static str) {
        let _ = self.failure.set(code);
        self.stop.cancel();
    }

    pub async fn stopped(&self) {
        let _ = tokio::time::timeout(CLEANUP_BUDGET * 2, self.done.cancelled()).await;
    }

    pub async fn session(
        &self,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<SessionInfo, &'static str> {
        let mut ready = self.ready.clone();
        loop {
            if cancellation.is_cancelled() {
                return Err("cancelled");
            }
            if Instant::now() >= deadline {
                return Err("timeout");
            }
            if !self.healthy() {
                return Err(self.failure.get().copied().unwrap_or("provider_crashed"));
            }
            if let Some(result) = ready.borrow().clone() {
                return result;
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err("cancelled"),
                _ = self.stop.cancelled() => return Err(self.failure.get().copied().unwrap_or("provider_crashed")),
                _ = tokio::time::sleep_until(deadline) => return Err("timeout"),
                changed = ready.changed() => if changed.is_err() { return Err("provider_crashed"); },
            }
        }
    }

    pub async fn request(
        &self,
        logical_id: String,
        method: &'static str,
        params: Value,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<JsonRpcResponse, String> {
        if cancellation.is_cancelled() {
            return Err("cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("timeout".into());
        }
        if !self.healthy() {
            return Err("provider_crashed".into());
        }
        let control = method == "bibit.job.cancel";
        let capacity = if control {
            &self.control_capacity
        } else {
            &self.capacity
        };
        let permit = Arc::clone(capacity)
            .try_acquire_owned()
            .map_err(|_| "resource_exhausted")?;
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let (reply, mut response) = oneshot::channel();
        let request = PendingRequest {
            logical_id,
            method,
            params,
            deadline,
            cancellation: cancellation.clone(),
            completion: CancellationToken::new(),
            phase: Arc::new(AtomicU8::new(QUEUED)),
            reply,
            _permit: permit,
        };
        let sender = if control {
            &self.controls
        } else {
            &self.requests
        };
        sender.try_send(request).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => "resource_exhausted",
            mpsc::error::TrySendError::Closed(_) => "provider_crashed",
        })?;
        let failure = tokio::select! {
            biased;
            result = &mut response => return result.unwrap_or_else(|_| Err("provider_crashed".into())),
            _ = cancellation.cancelled() => "cancelled",
            _ = tokio::time::sleep_until(deadline) => "timeout",
        };
        cancellation.cancel();
        if let Ok(Ok(result)) = tokio::time::timeout(CLEANUP_BUDGET * 2, response).await {
            return result;
        }
        Err(failure.into())
    }
}

struct ProviderOwner {
    stop: CancellationToken,
    done: CancellationToken,
    failure: Arc<OnceLock<&'static str>>,
    ready: watch::Sender<Option<Result<SessionInfo, &'static str>>>,
    requests: mpsc::Receiver<PendingRequest>,
    controls: mpsc::Receiver<PendingRequest>,
    jobs: Option<mpsc::Sender<ProviderJobEventParams>>,
    pending: BTreeMap<String, PendingRequest>,
    waiting: VecDeque<String>,
    notifications: VecDeque<WriteFrame>,
    expirations: FuturesUnordered<BoxFuture<'static, Option<(String, &'static str)>>>,
    wire_prefix: String,
    next_id: u64,
    protocol_version: u8,
    serial_busy: Option<String>,
    writer_busy: bool,
}

impl ProviderOwner {
    async fn run(
        mut self,
        config: ProviderConfig,
        service_id: String,
        initialize_id: String,
        deadline: Instant,
        cancellation: CancellationToken,
        predecessor: Option<CancellationToken>,
    ) {
        let _done_on_drop = self.done.clone().drop_guard();
        let _stop_on_drop = self.stop.clone().drop_guard();
        if let Some(predecessor) = predecessor {
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => { self.finish("provider_crashed"); return; },
                _ = cancellation.cancelled() => { self.finish("cancelled"); return; },
                _ = tokio::time::sleep_until(deadline) => { self.finish("timeout"); return; },
                _ = predecessor.cancelled() => {},
            }
        }
        let versions = if config.protocol_versions.contains(&PROVIDER_PROTOCOL_V2) {
            vec![PROVIDER_PROTOCOL_V2, PROTOCOL_VERSION]
        } else {
            vec![PROTOCOL_VERSION]
        };
        if self.stop.is_cancelled() || cancellation.is_cancelled() || Instant::now() >= deadline {
            self.finish(if cancellation.is_cancelled() {
                "cancelled"
            } else {
                "timeout"
            });
            return;
        }
        let (mut child, stdin, stdout) = match spawn_managed_process(
            &config.executable,
            &config.args,
            &config.data_dir,
            versions[0],
        ) {
            Ok(process) => process,
            Err(code) => {
                self.finish(code);
                return;
            }
        };
        let (write_tx, write_rx) = mpsc::channel(1);
        let (io_tx, mut io_rx) = mpsc::channel(EVENT_CAPACITY);
        let writer = tokio::spawn(run_writer(stdin, write_rx, io_tx.clone()));
        let reader = tokio::spawn(run_reader(stdout, io_tx));
        let initialize = frame(
            initialize_id.clone(),
            serde_json::json!({
                "jsonrpc": "2.0", "id": initialize_id, "method": "bibit.initialize",
                "params": { "protocolName": PROVIDER_PROTOCOL_NAME,
                    "supportedProtocolVersions": versions, "serviceId": service_id,
                    "client": { "name": "Bibit" } }
            }),
            deadline,
            Arc::new(AtomicU8::new(QUEUED)),
        );
        let initialized = match initialize {
            Ok(initialize) => {
                self.writer_busy = true;
                let _ = write_tx.try_send(initialize);
                self.initialize(&mut io_rx, &initialize_id, &config, deadline, &cancellation)
                    .await
            }
            Err(code) => Err(code),
        };
        let code = match initialized {
            Ok(info) => {
                self.protocol_version = info.protocol_version;
                self.ready.send_replace(Some(Ok(info)));
                self.drive(&mut child, &write_tx, &mut io_rx).await
            }
            Err(code) => code,
        };
        let _ = self.failure.set(code);
        self.stop.cancel();
        self.requests.close();
        self.controls.close();
        if !self.writer_busy {
            if let Ok(shutdown) = notification("bibit.shutdown", serde_json::json!({})) {
                let _ = write_tx.try_send(shutdown);
            }
            let _ = tokio::time::timeout(NOTIFICATION_BUDGET, child.wait()).await;
        }
        writer.abort();
        reader.abort();
        let _ = child.start_kill();
        let _ = tokio::time::timeout(CLEANUP_BUDGET, async {
            let _ = tokio::join!(writer, reader, child.wait());
        })
        .await;
        self.finish(code);
    }

    async fn initialize(
        &mut self,
        events: &mut mpsc::Receiver<IoEvent>,
        initialize_id: &str,
        config: &ProviderConfig,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<SessionInfo, &'static str> {
        loop {
            let event = tokio::select! {
                biased;
                _ = self.stop.cancelled() => return Err("provider_crashed"),
                _ = cancellation.cancelled() => return Err("cancelled"),
                _ = tokio::time::sleep_until(deadline) => return Err("timeout"),
                event = events.recv() => event.ok_or("provider_crashed")?,
            };
            match event {
                IoEvent::Written => self.writer_busy = false,
                IoEvent::Failed(code) => return Err(code),
                IoEvent::Message(value) => {
                    let response: JsonRpcResponse =
                        serde_json::from_value(value).map_err(|_| "incompatible")?;
                    if response.jsonrpc != "2.0"
                        || response.id != initialize_id
                        || response.error.is_some()
                    {
                        return Err("incompatible");
                    }
                    let initialized: ProviderInitializeResult =
                        serde_json::from_value(response.result.ok_or("incompatible")?)
                            .map_err(|_| "incompatible")?;
                    if initialized.provider_version.is_empty() || !initialized.capabilities.invoke {
                        return Err("incompatible");
                    }
                    match initialized.protocol_version {
                        PROTOCOL_VERSION => {}
                        PROVIDER_PROTOCOL_V2
                            if config.protocol_versions.contains(&PROVIDER_PROTOCOL_V2)
                                && initialized.capabilities.jobs
                                && initialized.capabilities.cancellation
                                && initialized.capabilities.max_concurrent_jobs == Some(1)
                                && self.jobs.is_some() => {}
                        _ => return Err("incompatible"),
                    }
                    return Ok(SessionInfo {
                        protocol_version: initialized.protocol_version,
                        operations: initialized.operations,
                    });
                }
            }
        }
    }

    fn admit(&mut self, request: PendingRequest, control: bool) {
        if request.cancellation.is_cancelled() || request.reply.is_closed() {
            request.finish(Err("cancelled".into()));
            return;
        }
        if Instant::now() >= request.deadline {
            request.finish(Err("timeout".into()));
            return;
        }
        self.next_id += 1;
        let id = format!("{}{}", self.wire_prefix, self.next_id);
        let cancellation = request.cancellation.clone();
        let completion = request.completion.clone();
        let deadline = request.deadline;
        let expiration_id = id.clone();
        self.expirations.push(Box::pin(async move {
            tokio::select! {
                biased;
                _ = completion.cancelled() => None,
                _ = tokio::time::sleep_until(deadline) => Some((expiration_id, "timeout")),
                _ = cancellation.cancelled() => Some((expiration_id, "cancelled")),
            }
        }));
        if control {
            self.waiting.push_front(id.clone());
        } else {
            self.waiting.push_back(id.clone());
        }
        self.pending.insert(id, request);
    }

    fn dispatch(&mut self, writer: &mpsc::Sender<WriteFrame>) -> Result<(), &'static str> {
        if self.writer_busy {
            return Ok(());
        }
        if let Some(notification) = self.notifications.pop_front() {
            writer
                .try_send(notification)
                .map_err(|_| "provider_crashed")?;
            self.writer_busy = true;
            return Ok(());
        }
        if self.protocol_version == PROTOCOL_VERSION && self.serial_busy.is_some() {
            return Ok(());
        }
        while let Some(id) = self.waiting.pop_front() {
            let Some(request) = self.pending.get(&id) else {
                continue;
            };
            if request.cancellation.is_cancelled()
                || request.reply.is_closed()
                || Instant::now() >= request.deadline
            {
                let code = if Instant::now() >= request.deadline {
                    "timeout"
                } else {
                    "cancelled"
                };
                self.pending.remove(&id).unwrap().finish(Err(code.into()));
                continue;
            }
            let wire_id = if self.protocol_version == PROTOCOL_VERSION {
                &request.logical_id
            } else {
                &id
            };
            let outgoing = frame(
                id.clone(),
                serde_json::json!({
                    "jsonrpc": "2.0", "id": wire_id, "method": request.method, "params": request.params,
                }),
                request.deadline,
                Arc::clone(&request.phase),
            );
            match outgoing {
                Ok(outgoing) => {
                    writer.try_send(outgoing).map_err(|_| "provider_crashed")?;
                    self.writer_busy = true;
                    if self.protocol_version == PROTOCOL_VERSION {
                        self.serial_busy = Some(id);
                    }
                    break;
                }
                Err(code) => self.pending.remove(&id).unwrap().finish(Err(code.into())),
            }
        }
        Ok(())
    }

    async fn drive(
        &mut self,
        child: &mut Child,
        writer: &mpsc::Sender<WriteFrame>,
        events: &mut mpsc::Receiver<IoEvent>,
    ) -> &'static str {
        loop {
            if self.stop.is_cancelled() {
                return self.failure.get().copied().unwrap_or("provider_crashed");
            }
            if let Err(code) = self.dispatch(writer) {
                return code;
            }
            let notification_deadline = self.notifications.front().map(|frame| frame.deadline);
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => return self.failure.get().copied().unwrap_or("provider_crashed"),
                _ = tokio::time::sleep_until(notification_deadline.unwrap_or_else(Instant::now)), if notification_deadline.is_some() => return "timeout",
                expiration = self.expirations.next(), if !self.expirations.is_empty() => {
                    if let Some(Some((id, code))) = expiration {
                        if let Err(code) = self.expire(&id, code, writer, child).await { return code; }
                    }
                }
                request = self.controls.recv(), if !self.controls.is_closed() => {
                    if let Some(request) = request { self.admit(request, true); }
                }
                event = events.recv() => match event {
                    Some(IoEvent::Written) => self.writer_busy = false,
                    Some(IoEvent::Failed(code)) => return code,
                    Some(IoEvent::Message(value)) => if let Err(code) = self.message(value) { return code; },
                    None => return "provider_crashed",
                },
                request = self.requests.recv(), if !self.requests.is_closed() => {
                    if let Some(request) = request { self.admit(request, false); }
                }
                _ = child.wait() => return "provider_crashed",
            }
        }
    }

    async fn expire(
        &mut self,
        id: &str,
        code: &'static str,
        writer: &mpsc::Sender<WriteFrame>,
        child: &mut Child,
    ) -> Result<(), &'static str> {
        let Some(request) = self.pending.get(id) else {
            return Ok(());
        };
        let phase = request
            .phase
            .compare_exchange(QUEUED, DISCARDED, Ordering::AcqRel, Ordering::Acquire)
            .unwrap_or_else(|phase| phase);
        if matches!(phase, WRITING | BROKEN)
            || request.method == "bibit.job.cancel"
            || (phase == WRITTEN && request.method == "bibit.job.start")
        {
            return Err(code);
        }
        if phase == WRITTEN {
            let wire_id = if self.protocol_version == PROTOCOL_VERSION {
                request.logical_id.as_str()
            } else {
                id
            };
            let cancel = notification("bibit.cancel", serde_json::json!({ "requestId": wire_id }))?;
            if self.protocol_version == PROTOCOL_VERSION {
                let _ = writer.try_send(cancel);
                let _ = tokio::time::timeout(NOTIFICATION_BUDGET, child.wait()).await;
                return Err(code);
            }
            if self.notifications.len() >= CONTROL_CAPACITY {
                return Err("resource_exhausted");
            }
            self.notifications.push_back(cancel);
        }
        self.waiting.retain(|waiting| waiting != id);
        if self.serial_busy.as_deref() == Some(id) {
            self.serial_busy = None;
        }
        self.pending.remove(id).unwrap().finish(Err(code.into()));
        Ok(())
    }

    fn message(&mut self, value: Value) -> Result<(), &'static str> {
        let object = value.as_object().ok_or("incompatible")?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err("incompatible");
        }
        if object.contains_key("id") {
            let mut response: JsonRpcResponse =
                serde_json::from_value(value).map_err(|_| "incompatible")?;
            if response.result.is_some() == response.error.is_some() {
                return Err("incompatible");
            }
            let wire_id = response.id.as_str().ok_or("incompatible")?;
            let id = if self.protocol_version == PROTOCOL_VERSION {
                let id = self.serial_busy.as_ref().ok_or("incompatible")?;
                if self
                    .pending
                    .get(id)
                    .is_none_or(|request| request.logical_id != wire_id)
                {
                    return Err("incompatible");
                }
                id.clone()
            } else {
                wire_id.to_owned()
            };
            let Some(request) = self.pending.get(&id) else {
                if self.protocol_version == PROVIDER_PROTOCOL_V2
                    && id
                        .strip_prefix(&self.wire_prefix)
                        .and_then(|suffix| suffix.parse::<u64>().ok())
                        .is_some_and(|sequence| sequence > 0 && sequence <= self.next_id)
                {
                    return Ok(());
                }
                return Err("incompatible");
            };
            if !matches!(request.phase.load(Ordering::Acquire), WRITING | WRITTEN) {
                return Err("incompatible");
            }
            response.id = Value::String(request.logical_id.clone());
            if self.serial_busy.as_deref() == Some(id.as_str()) {
                self.serial_busy = None;
            }
            self.pending.remove(&id).unwrap().finish(Ok(response));
            return Ok(());
        }
        if self.protocol_version != PROVIDER_PROTOCOL_V2
            || object.get("method").and_then(Value::as_str) != Some("bibit.jobEvent")
        {
            return Err("incompatible");
        }
        let event = serde_json::from_value(object.get("params").cloned().ok_or("incompatible")?)
            .map_err(|_| "incompatible")?;
        self.jobs
            .as_ref()
            .ok_or("incompatible")?
            .try_send(event)
            .map_err(|_| "resource_exhausted")
    }

    fn finish(&mut self, code: &'static str) {
        let _ = self.failure.set(code);
        self.stop.cancel();
        self.ready.send_replace(Some(Err(code)));
        self.requests.close();
        self.controls.close();
        for request in std::mem::take(&mut self.pending).into_values() {
            let failure = if Instant::now() >= request.deadline {
                "timeout"
            } else if request.cancellation.is_cancelled() {
                "cancelled"
            } else {
                code
            };
            request.finish(Err(failure.into()));
        }
        while let Ok(request) = self.requests.try_recv() {
            request.finish(Err(code.into()));
        }
        while let Ok(request) = self.controls.try_recv() {
            request.finish(Err(code.into()));
        }
    }
}

fn frame(
    id: String,
    value: Value,
    deadline: Instant,
    phase: Arc<AtomicU8>,
) -> Result<WriteFrame, &'static str> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "incompatible")?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("resource_exhausted");
    }
    bytes.push(b'\n');
    Ok(WriteFrame {
        id,
        bytes,
        deadline,
        phase,
    })
}

fn notification(method: &'static str, params: Value) -> Result<WriteFrame, &'static str> {
    frame(
        String::new(),
        serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        Instant::now() + NOTIFICATION_BUDGET,
        Arc::new(AtomicU8::new(QUEUED)),
    )
}

async fn run_writer(
    mut stdin: ChildStdin,
    mut frames: mpsc::Receiver<WriteFrame>,
    events: mpsc::Sender<IoEvent>,
) {
    while let Some(frame) = frames.recv().await {
        if frame
            .phase
            .compare_exchange(QUEUED, WRITING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            if events.send(IoEvent::Written).await.is_err() {
                return;
            }
            continue;
        }
        if Instant::now() >= frame.deadline {
            frame.phase.store(DISCARDED, Ordering::Release);
            if frame.id.is_empty() {
                let _ = events.send(IoEvent::Failed("timeout")).await;
                return;
            }
            if events.send(IoEvent::Written).await.is_err() {
                return;
            }
            continue;
        }
        let result = tokio::time::timeout_at(frame.deadline, async {
            stdin.write_all(&frame.bytes).await?;
            stdin.flush().await
        })
        .await;
        let event = match result {
            Ok(Ok(())) => {
                frame.phase.store(WRITTEN, Ordering::Release);
                IoEvent::Written
            }
            failure => {
                frame.phase.store(BROKEN, Ordering::Release);
                let code = if failure.is_err() {
                    "timeout"
                } else {
                    "provider_crashed"
                };
                let _ = events.send(IoEvent::Failed(code)).await;
                return;
            }
        };
        if events.send(event).await.is_err() {
            return;
        }
    }
}

async fn run_reader(mut stdout: BufReader<ChildStdout>, events: mpsc::Sender<IoEvent>) {
    loop {
        let result = read_rpc_value(&mut stdout).await;
        let failed = result.is_err();
        let event = match result {
            Ok(value) => IoEvent::Message(value),
            Err(code) => IoEvent::Failed(code),
        };
        if events.send(event).await.is_err() || failed {
            return;
        }
    }
}

async fn run_job_events(
    driver: Arc<ManagedV2Driver>,
    mut events: mpsc::Receiver<ProviderJobEventParams>,
) {
    loop {
        tokio::select! {
            biased;
            _ = driver.transport.stop.cancelled() => break,
            event = events.recv() => match event {
                Some(event) => if let Err(code) = driver.handle_job_event(event).await {
                    driver.transport.request_stop(code);
                    break;
                },
                None => break,
            }
        }
    }
    while let Ok(event) = events.try_recv() {
        if driver.handle_job_event(event).await.is_err() {
            break;
        }
    }
    driver.transport.stopped().await;
    driver
        .fail_jobs(
            driver
                .transport
                .failure
                .get()
                .copied()
                .unwrap_or("provider_crashed"),
        )
        .await;
}
