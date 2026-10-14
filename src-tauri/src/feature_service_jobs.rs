use crate::feature_file_grants::{
    FeatureFileGrantService, FileGrantDirection, FileGrantOwner, PreparedDownload, StagedFile,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_EVENTS_PER_JOB: usize = 256;
const MIN_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Finalizing,
    CancelRequested,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobEventKind {
    Status,
    Progress,
    Result,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub completed_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub version: u8,
    pub job_id: String,
    pub sequence: u64,
    pub kind: JobEventKind,
    pub status: JobStatus,
    pub emitted_at: chrono::DateTime<chrono::Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<JobProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JobFailure>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFailure {
    pub version: u8,
    pub code: FeatureServiceErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeatureServiceErrorCode {
    Cancelled,
    Offline,
    Timeout,
    Unauthorized,
    Incompatible,
    Unavailable,
    ProviderCrashed,
    ResourceExhausted,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub version: u8,
    pub job_id: String,
    pub owner: JobOwnerView,
    pub service_id: String,
    pub operation_id: String,
    pub idempotency_key: String,
    pub status: JobStatus,
    pub last_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<JobProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JobFailure>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOwnerView {
    pub feature_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct StartJobRequest {
    pub owner: FileGrantOwner,
    pub service_id: String,
    pub operation_id: String,
    pub idempotency_key: String,
    pub grant_id: String,
    pub direction: FileGrantDirection,
    pub input: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct StartJobOutcome {
    pub created: bool,
    pub snapshot: JobSnapshot,
    pub staged: Option<StagedFile>,
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum JobError {
    #[error("invalid_request")]
    InvalidRequest,
    #[error("idempotency_conflict")]
    IdempotencyConflict,
    #[error("busy")]
    Busy(JobSnapshot),
    #[error("not_found")]
    NotFound,
    #[error("invalid_transition")]
    InvalidTransition,
    #[error("cancel_requested")]
    CancelRequested,
    #[error("too_late")]
    TooLate,
    #[error("terminal")]
    Terminal,
    #[error("file_grant")]
    FileGrant,
    #[error("registry_unavailable")]
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEventBatch {
    pub snapshot: JobSnapshot,
    pub events: Vec<JobEvent>,
    pub has_gap: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancellationDecision {
    pub status: JobStatus,
    pub provider_cancel_required: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct IdempotencyNamespace {
    feature_id: String,
    service_id: String,
    key: String,
}

struct JobRecord {
    owner: FileGrantOwner,
    request_hash: String,
    grant_id: String,
    direction: FileGrantDirection,
    staged: StagedFile,
    snapshot: JobSnapshot,
    events: VecDeque<JobEvent>,
    last_progress_emit: Option<Instant>,
}

#[derive(Default)]
struct JobRegistryState {
    jobs: BTreeMap<String, JobRecord>,
    idempotency: BTreeMap<IdempotencyNamespace, String>,
    latest_terminal: BTreeMap<(String, String), String>,
}

pub struct FeatureServiceJobRegistry {
    file_grants: Arc<FeatureFileGrantService>,
    state: Mutex<JobRegistryState>,
}

fn request_hash(request: &StartJobRequest) -> String {
    let direction = match request.direction {
        FileGrantDirection::Upload => "upload",
        FileGrantDirection::Download => "download",
    };
    let source = serde_json::to_vec(&(
        &request.operation_id,
        &request.grant_id,
        direction,
        &request.input,
    ))
    .expect("job request is JSON serializable");
    format!("{:x}", Sha256::digest(source))
}

fn public_owner(owner: &FileGrantOwner) -> JobOwnerView {
    JobOwnerView {
        feature_id: owner.feature_id.clone(),
    }
}

fn push_event(record: &mut JobRecord, kind: JobEventKind) {
    record.snapshot.last_sequence += 1;
    record.events.push_back(JobEvent {
        version: 1,
        job_id: record.snapshot.job_id.clone(),
        sequence: record.snapshot.last_sequence,
        kind,
        status: record.snapshot.status,
        emitted_at: chrono::Utc::now(),
        progress: (kind == JobEventKind::Progress)
            .then(|| record.snapshot.progress.clone())
            .flatten(),
        result: (kind == JobEventKind::Result)
            .then(|| record.snapshot.result.clone())
            .flatten(),
        error: (kind == JobEventKind::Error)
            .then(|| record.snapshot.error.clone())
            .flatten(),
    });
    while record.events.len() > MAX_EVENTS_PER_JOB {
        let removable = record
            .events
            .iter()
            .position(|event| event.kind == JobEventKind::Progress && !event.status.terminal())
            .or_else(|| {
                record
                    .events
                    .iter()
                    .position(|event| !event.status.terminal())
            });
        if let Some(index) = removable {
            record.events.remove(index);
        } else {
            break;
        }
    }
}

fn retain_latest_terminal(
    state: &mut JobRegistryState,
    terminal_key: (String, String),
    job_id: &str,
) {
    if let Some(previous) = state.latest_terminal.insert(terminal_key, job_id.into()) {
        if previous != job_id {
            state.jobs.remove(&previous);
            state.idempotency.retain(|_, mapped| mapped != &previous);
        }
    }
}

impl FeatureServiceJobRegistry {
    pub fn new(file_grants: Arc<FeatureFileGrantService>) -> Self {
        Self {
            file_grants,
            state: Mutex::new(JobRegistryState::default()),
        }
    }

    pub(crate) fn file_grants(&self) -> &Arc<FeatureFileGrantService> {
        &self.file_grants
    }

    pub(crate) fn start(&self, request: StartJobRequest) -> Result<StartJobOutcome, JobError> {
        if request.idempotency_key.is_empty()
            || request.idempotency_key.len() > 128
            || !request.input.is_object()
        {
            return Err(JobError::InvalidRequest);
        }
        let namespace = IdempotencyNamespace {
            feature_id: request.owner.feature_id.clone(),
            service_id: request.service_id.clone(),
            key: request.idempotency_key.clone(),
        };
        let fingerprint = request_hash(&request);
        let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        if let Some(job_id) = state.idempotency.get(&namespace) {
            let record = state.jobs.get(job_id).ok_or(JobError::Unavailable)?;
            if record.request_hash != fingerprint || record.owner != request.owner {
                return Err(JobError::IdempotencyConflict);
            }
            return Ok(StartJobOutcome {
                created: false,
                snapshot: record.snapshot.clone(),
                staged: None,
            });
        }
        if let Some(active) = state.jobs.values().find(|record| {
            record.owner.feature_id == request.owner.feature_id
                && record.snapshot.service_id == request.service_id
                && !record.snapshot.status.terminal()
        }) {
            return Err(JobError::Busy(active.snapshot.clone()));
        }

        let staged = match request.direction {
            FileGrantDirection::Upload => self.file_grants.consume_upload(
                &request.grant_id,
                &request.owner,
                &request.service_id,
                &request.operation_id,
            ),
            FileGrantDirection::Download => self.file_grants.consume_download(
                &request.grant_id,
                &request.owner,
                &request.service_id,
                &request.operation_id,
            ),
        }
        .map_err(|_| JobError::FileGrant)?;
        let job_id = uuid::Uuid::new_v4().to_string();
        let feature_instance_id = request.owner.feature_instance_id.clone();
        let grant_id = request.grant_id.clone();
        let snapshot = JobSnapshot {
            version: 1,
            job_id: job_id.clone(),
            owner: public_owner(&request.owner),
            service_id: request.service_id,
            operation_id: request.operation_id,
            idempotency_key: request.idempotency_key,
            status: JobStatus::Queued,
            last_sequence: 0,
            progress: None,
            result: None,
            error: None,
        };
        let mut record = JobRecord {
            owner: request.owner,
            request_hash: fingerprint,
            grant_id: request.grant_id,
            direction: request.direction,
            staged: staged.clone(),
            snapshot,
            events: VecDeque::new(),
            last_progress_emit: None,
        };
        push_event(&mut record, JobEventKind::Status);
        let snapshot = record.snapshot.clone();
        state.idempotency.insert(namespace, job_id.clone());
        state.jobs.insert(job_id.clone(), record);
        let staging_root = self
            .file_grants
            .data_root()
            .join("providers")
            .join(&snapshot.service_id)
            .join("transfers");
        let Some(staging_path) = staged
            .absolute_path
            .parent()
            .and_then(|path| path.strip_prefix(&staging_root).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
        else {
            state.jobs.remove(&job_id);
            state.idempotency.retain(|_, mapped| mapped != &job_id);
            drop(state);
            self.file_grants.cleanup_grant(&grant_id);
            return Err(JobError::Unavailable);
        };
        if crate::trusted_plugins::record_cleanup_ledger_entry(
            self.file_grants.data_root(),
            &snapshot.owner.feature_id,
            &feature_instance_id,
            &snapshot.service_id,
            &job_id,
            &staging_path,
        )
        .is_err()
        {
            state.jobs.remove(&job_id);
            state.idempotency.retain(|_, mapped| mapped != &job_id);
            drop(state);
            self.file_grants.cleanup_grant(&grant_id);
            return Err(JobError::Unavailable);
        }
        Ok(StartJobOutcome {
            created: true,
            snapshot,
            staged: Some(staged),
        })
    }

    pub(crate) fn mark_running(&self, job_id: &str) -> Result<JobSnapshot, JobError> {
        self.transition(
            job_id,
            JobStatus::Queued,
            JobStatus::Running,
            JobEventKind::Status,
        )
    }

    pub(crate) fn propose_result(&self, job_id: &str) -> Result<JobSnapshot, JobError> {
        let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
        if record.snapshot.status == JobStatus::CancelRequested {
            return Err(JobError::CancelRequested);
        }
        if record.snapshot.status != JobStatus::Running {
            return Err(if record.snapshot.status.terminal() {
                JobError::Terminal
            } else {
                JobError::InvalidTransition
            });
        }
        record.snapshot.status = JobStatus::Finalizing;
        push_event(record, JobEventKind::Status);
        Ok(record.snapshot.clone())
    }

    pub(crate) fn succeed(&self, job_id: &str, result: Value) -> Result<JobSnapshot, JobError> {
        let snapshot = {
            let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
            let (snapshot, terminal_key) = {
                let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
                if record.snapshot.status != JobStatus::Finalizing {
                    return Err(if record.snapshot.status.terminal() {
                        JobError::Terminal
                    } else if record.snapshot.status == JobStatus::CancelRequested {
                        JobError::CancelRequested
                    } else {
                        JobError::InvalidTransition
                    });
                }
                record.snapshot.status = JobStatus::Succeeded;
                record.snapshot.result = Some(result);
                push_event(record, JobEventKind::Result);
                (
                    record.snapshot.clone(),
                    (
                        record.owner.feature_id.clone(),
                        record.snapshot.service_id.clone(),
                    ),
                )
            };
            retain_latest_terminal(&mut state, terminal_key, job_id);
            snapshot
        };
        self.cleanup_job_grant(job_id);
        Ok(snapshot)
    }

    pub(crate) fn fail(
        &self,
        job_id: &str,
        code: FeatureServiceErrorCode,
        message: &str,
        retryable: bool,
    ) -> Result<JobSnapshot, JobError> {
        let snapshot = {
            let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
            let (snapshot, terminal_key) = {
                let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
                if record.snapshot.status.terminal() {
                    return Err(JobError::Terminal);
                }
                record.snapshot.status = JobStatus::Failed;
                record.snapshot.error = Some(JobFailure {
                    version: 1,
                    code,
                    message: message.into(),
                    retryable,
                });
                push_event(record, JobEventKind::Error);
                (
                    record.snapshot.clone(),
                    (
                        record.owner.feature_id.clone(),
                        record.snapshot.service_id.clone(),
                    ),
                )
            };
            retain_latest_terminal(&mut state, terminal_key, job_id);
            snapshot
        };
        self.cleanup_job_grant(job_id);
        Ok(snapshot)
    }

    pub(crate) fn provider_cancelled(&self, job_id: &str) -> Result<JobSnapshot, JobError> {
        let snapshot = {
            let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
            let (snapshot, terminal_key) = {
                let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
                if record.snapshot.status != JobStatus::CancelRequested {
                    return Err(if record.snapshot.status.terminal() {
                        JobError::Terminal
                    } else {
                        JobError::InvalidTransition
                    });
                }
                record.snapshot.status = JobStatus::Cancelled;
                record.snapshot.error = Some(JobFailure {
                    version: 1,
                    code: FeatureServiceErrorCode::Cancelled,
                    message: "The job was cancelled".into(),
                    retryable: false,
                });
                push_event(record, JobEventKind::Error);
                (
                    record.snapshot.clone(),
                    (
                        record.owner.feature_id.clone(),
                        record.snapshot.service_id.clone(),
                    ),
                )
            };
            retain_latest_terminal(&mut state, terminal_key, job_id);
            snapshot
        };
        self.cleanup_job_grant(job_id);
        Ok(snapshot)
    }

    pub(crate) fn cancel(
        &self,
        owner: &FileGrantOwner,
        job_id: &str,
    ) -> Result<CancellationDecision, JobError> {
        let mut cleanup = false;
        let decision = {
            let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
            let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
            if &record.owner != owner {
                return Err(JobError::NotFound);
            }
            let terminal_key = (
                record.owner.feature_id.clone(),
                record.snapshot.service_id.clone(),
            );
            let decision = match record.snapshot.status {
                JobStatus::Queued => {
                    record.snapshot.status = JobStatus::Cancelled;
                    record.snapshot.error = Some(JobFailure {
                        version: 1,
                        code: FeatureServiceErrorCode::Cancelled,
                        message: "The job was cancelled".into(),
                        retryable: false,
                    });
                    push_event(record, JobEventKind::Error);
                    cleanup = true;
                    CancellationDecision {
                        status: JobStatus::Cancelled,
                        provider_cancel_required: false,
                    }
                }
                JobStatus::Running | JobStatus::Finalizing => {
                    record.snapshot.status = JobStatus::CancelRequested;
                    push_event(record, JobEventKind::Status);
                    CancellationDecision {
                        status: JobStatus::CancelRequested,
                        provider_cancel_required: true,
                    }
                }
                JobStatus::CancelRequested => CancellationDecision {
                    status: JobStatus::CancelRequested,
                    provider_cancel_required: false,
                },
                status if status.terminal() => return Err(JobError::TooLate),
                _ => return Err(JobError::InvalidTransition),
            };
            if cleanup {
                retain_latest_terminal(&mut state, terminal_key, job_id);
            }
            decision
        };
        if cleanup {
            self.cleanup_job_grant(job_id);
        }
        Ok(decision)
    }

    pub(crate) fn record_progress_at(
        &self,
        job_id: &str,
        completed_bytes: u64,
        total_bytes: Option<u64>,
        now: Instant,
    ) -> Result<JobSnapshot, JobError> {
        if total_bytes.is_some_and(|total| completed_bytes > total) {
            return Err(JobError::InvalidRequest);
        }
        let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
        if !matches!(
            record.snapshot.status,
            JobStatus::Running | JobStatus::Finalizing
        ) {
            return Err(if record.snapshot.status == JobStatus::CancelRequested {
                JobError::CancelRequested
            } else if record.snapshot.status.terminal() {
                JobError::Terminal
            } else {
                JobError::InvalidTransition
            });
        }
        if record
            .snapshot
            .progress
            .as_ref()
            .is_some_and(|progress| completed_bytes < progress.completed_bytes)
        {
            return Err(JobError::InvalidRequest);
        }
        record.snapshot.progress = Some(JobProgress {
            completed_bytes,
            total_bytes,
        });
        if record.last_progress_emit.is_none_or(|last| {
            now.checked_duration_since(last)
                .is_some_and(|elapsed| elapsed >= MIN_PROGRESS_INTERVAL)
        }) {
            record.last_progress_emit = Some(now);
            push_event(record, JobEventKind::Progress);
        }
        Ok(record.snapshot.clone())
    }

    pub(crate) fn snapshot(
        &self,
        owner: &FileGrantOwner,
        job_id: &str,
    ) -> Result<JobSnapshot, JobError> {
        let state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let record = state.jobs.get(job_id).ok_or(JobError::NotFound)?;
        (&record.owner == owner)
            .then(|| record.snapshot.clone())
            .ok_or(JobError::NotFound)
    }

    pub(crate) fn events(
        &self,
        owner: &FileGrantOwner,
        job_id: &str,
        after_sequence: u64,
    ) -> Result<JobEventBatch, JobError> {
        let state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let record = state.jobs.get(job_id).ok_or(JobError::NotFound)?;
        if &record.owner != owner {
            return Err(JobError::NotFound);
        }
        let events = record
            .events
            .iter()
            .filter(|event| event.sequence > after_sequence)
            .cloned()
            .collect::<Vec<_>>();
        let next_sequence = events
            .iter()
            .try_fold(after_sequence.saturating_add(1), |expected, event| {
                (event.sequence == expected).then_some(expected.saturating_add(1))
            });
        let has_gap = after_sequence < record.snapshot.last_sequence
            && next_sequence.is_none_or(|next| next <= record.snapshot.last_sequence);
        Ok(JobEventBatch {
            snapshot: record.snapshot.clone(),
            events,
            has_gap,
        })
    }

    pub(crate) fn staged_file(&self, job_id: &str) -> Result<StagedFile, JobError> {
        self.state
            .lock()
            .map_err(|_| JobError::Unavailable)?
            .jobs
            .get(job_id)
            .map(|record| record.staged.clone())
            .ok_or(JobError::NotFound)
    }

    pub(crate) fn transfer(
        &self,
        job_id: &str,
    ) -> Result<(FileGrantDirection, StagedFile), JobError> {
        let state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let record = state.jobs.get(job_id).ok_or(JobError::NotFound)?;
        Ok((record.direction, record.staged.clone()))
    }

    pub(crate) fn complete_finalizing(
        &self,
        job_id: &str,
        prepared_download: Option<PreparedDownload>,
        result: Value,
    ) -> Result<JobSnapshot, JobError> {
        let snapshot = {
            let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
            let (snapshot, terminal_key) = {
                let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
                match record.snapshot.status {
                    JobStatus::Finalizing => {
                        match prepared_download.map(PreparedDownload::commit).transpose() {
                            Ok(_) => {
                                record.snapshot.status = JobStatus::Succeeded;
                                record.snapshot.result = Some(result);
                                push_event(record, JobEventKind::Result);
                            }
                            Err(_) => {
                                record.snapshot.status = JobStatus::Failed;
                                record.snapshot.error = Some(JobFailure {
                                    version: 1,
                                    code: FeatureServiceErrorCode::Unknown,
                                    message: "Download finalization failed".into(),
                                    retryable: true,
                                });
                                push_event(record, JobEventKind::Error);
                            }
                        }
                    }
                    JobStatus::CancelRequested => {
                        record.snapshot.status = JobStatus::Cancelled;
                        record.snapshot.error = Some(JobFailure {
                            version: 1,
                            code: FeatureServiceErrorCode::Cancelled,
                            message: "The job was cancelled".into(),
                            retryable: false,
                        });
                        push_event(record, JobEventKind::Error);
                    }
                    status if status.terminal() => return Err(JobError::Terminal),
                    _ => return Err(JobError::InvalidTransition),
                }
                (
                    record.snapshot.clone(),
                    (
                        record.owner.feature_id.clone(),
                        record.snapshot.service_id.clone(),
                    ),
                )
            };
            retain_latest_terminal(&mut state, terminal_key, job_id);
            snapshot
        };
        self.cleanup_job_grant(job_id);
        Ok(snapshot)
    }

    pub(crate) fn list(
        &self,
        owner: &FileGrantOwner,
        service_id: &str,
    ) -> Result<Vec<JobSnapshot>, JobError> {
        let state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let latest_terminal = state
            .latest_terminal
            .get(&(owner.feature_id.clone(), service_id.into()));
        Ok(state
            .jobs
            .iter()
            .filter_map(|(job_id, record)| {
                (&record.owner == owner
                    && record.snapshot.service_id == service_id
                    && (!record.snapshot.status.terminal() || latest_terminal == Some(job_id)))
                .then(|| record.snapshot.clone())
            })
            .collect())
    }

    pub(crate) fn job_authority(
        &self,
        owner: &FileGrantOwner,
        job_id: &str,
    ) -> Result<(String, String), JobError> {
        let state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let record = state.jobs.get(job_id).ok_or(JobError::NotFound)?;
        if &record.owner != owner {
            return Err(JobError::NotFound);
        }
        Ok((
            record.snapshot.service_id.clone(),
            record.snapshot.operation_id.clone(),
        ))
    }

    pub(crate) fn cleanup_owner_instance(&self, owner: &FileGrantOwner) -> Vec<String> {
        let active = {
            let Ok(mut state) = self.state.lock() else {
                self.file_grants
                    .cleanup_owner_instance(&owner.feature_id, &owner.feature_instance_id);
                return Vec::new();
            };
            let job_ids = state
                .jobs
                .iter()
                .filter_map(|(job_id, record)| (&record.owner == owner).then(|| job_id.clone()))
                .collect::<Vec<_>>();
            let mut active = Vec::new();
            for job_id in &job_ids {
                if let Some(record) = state.jobs.remove(job_id) {
                    if !record.snapshot.status.terminal() {
                        active.push(job_id.clone());
                    }
                }
            }
            state
                .idempotency
                .retain(|_, job_id| !job_ids.contains(job_id));
            state
                .latest_terminal
                .retain(|_, job_id| !job_ids.contains(job_id));
            active
        };
        self.file_grants
            .cleanup_owner_instance(&owner.feature_id, &owner.feature_instance_id);
        active
    }

    pub(crate) fn active_jobs_with_staging(
        &self,
        owner: &FileGrantOwner,
    ) -> Vec<(String, String, String)> {
        self.state
            .lock()
            .map(|state| {
                state
                    .jobs
                    .iter()
                    .filter_map(|(job_id, record)| {
                        if &record.owner != owner || record.snapshot.status.terminal() {
                            return None;
                        }
                        let root = self
                            .file_grants
                            .data_root()
                            .join("providers")
                            .join(&record.snapshot.service_id)
                            .join("transfers");
                        let relative = record
                            .staged
                            .absolute_path
                            .parent()
                            .and_then(|path| path.strip_prefix(root).ok())?
                            .to_string_lossy()
                            .replace('\\', "/");
                        Some((record.snapshot.service_id.clone(), job_id.clone(), relative))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn transition(
        &self,
        job_id: &str,
        from: JobStatus,
        to: JobStatus,
        kind: JobEventKind,
    ) -> Result<JobSnapshot, JobError> {
        let mut state = self.state.lock().map_err(|_| JobError::Unavailable)?;
        let record = state.jobs.get_mut(job_id).ok_or(JobError::NotFound)?;
        if record.snapshot.status != from {
            return Err(if record.snapshot.status.terminal() {
                JobError::Terminal
            } else {
                JobError::InvalidTransition
            });
        }
        record.snapshot.status = to;
        push_event(record, kind);
        Ok(record.snapshot.clone())
    }

    fn cleanup_job_grant(&self, job_id: &str) {
        let details = self.state.lock().ok().and_then(|state| {
            state.jobs.get(job_id).map(|record| {
                (
                    record.grant_id.clone(),
                    (
                        record.owner.feature_id.clone(),
                        record.snapshot.service_id.clone(),
                    ),
                )
            })
        });
        if let Some((grant_id, (feature_id, _service_id))) = details {
            self.file_grants.cleanup_grant(&grant_id);
            let _ = crate::trusted_plugins::remove_cleanup_ledger_entry(
                self.file_grants.data_root(),
                &feature_id,
                job_id,
            );
        }
    }

    #[cfg(test)]
    fn job_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.jobs.len())
            .unwrap_or_default()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureJobStartCommandRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    service_id: String,
    operation_id: String,
    idempotency_key: String,
    grant_id: String,
    input: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureJobIdentityCommandRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureJobEventsCommandRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    job_id: String,
    after_sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureJobListCommandRequest {
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
    service_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureJobCommandError {
    version: u8,
    code: FeatureServiceErrorCode,
    message: &'static str,
    retryable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureJobAvailability {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

fn command_error(code: FeatureServiceErrorCode) -> FeatureJobCommandError {
    let (message, retryable) = match code {
        FeatureServiceErrorCode::Cancelled => ("The job was cancelled", false),
        FeatureServiceErrorCode::Offline => ("The Provider is offline", true),
        FeatureServiceErrorCode::Timeout => ("The Provider timed out", true),
        FeatureServiceErrorCode::Unauthorized => ("The operation is not authorized", false),
        FeatureServiceErrorCode::Incompatible => ("The request is incompatible", false),
        FeatureServiceErrorCode::Unavailable => ("The job is unavailable", true),
        FeatureServiceErrorCode::ProviderCrashed => ("The Provider stopped unexpectedly", true),
        FeatureServiceErrorCode::ResourceExhausted => {
            ("The operation resource limit was reached", true)
        }
        FeatureServiceErrorCode::Unknown => ("The job failed", true),
    };
    FeatureJobCommandError {
        version: 1,
        code,
        message,
        retryable,
    }
}

fn map_job_error(error: JobError) -> FeatureJobCommandError {
    command_error(match error {
        JobError::InvalidRequest
        | JobError::IdempotencyConflict
        | JobError::InvalidTransition
        | JobError::TooLate
        | JobError::Terminal => FeatureServiceErrorCode::Incompatible,
        JobError::Busy(_) => FeatureServiceErrorCode::ResourceExhausted,
        JobError::CancelRequested => FeatureServiceErrorCode::Cancelled,
        JobError::FileGrant => FeatureServiceErrorCode::Unauthorized,
        JobError::NotFound | JobError::Unavailable => FeatureServiceErrorCode::Unavailable,
    })
}

fn command_owner(
    feature_id: String,
    plugin_version: String,
    feature_instance_token: String,
) -> Result<FileGrantOwner, FeatureJobCommandError> {
    if !crate::trusted_plugins::validate_feature_instance_version_capability(
        &feature_id,
        &plugin_version,
        &feature_instance_token,
        "job:manage",
    ) {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    Ok(FileGrantOwner {
        feature_id,
        feature_instance_id: feature_instance_token,
    })
}

fn operation_authorized(owner: &FileGrantOwner, service_id: &str, operation_id: &str) -> bool {
    crate::trusted_plugins::validate_feature_instance_capability(
        &owner.feature_id,
        &owner.feature_instance_id,
        &format!("service:{service_id}"),
    ) && crate::feature_capabilities::runtime_grants_allow(
        &owner.feature_id,
        service_id,
        operation_id,
        "job:manage",
    )
}

fn service_authorized(owner: &FileGrantOwner, service_id: &str) -> bool {
    crate::trusted_plugins::validate_feature_instance_capability(
        &owner.feature_id,
        &owner.feature_instance_id,
        &format!("service:{service_id}"),
    ) && crate::feature_capabilities::runtime_service_capabilities_allow(
        &owner.feature_id,
        service_id,
        "job:manage",
    )
}

#[tauri::command]
pub async fn feature_service_job_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<FeatureServiceJobRegistry>>,
    request: FeatureJobStartCommandRequest,
) -> Result<JobSnapshot, FeatureJobCommandError> {
    if window.label() != "main" {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let owner = command_owner(
        request.feature_id,
        request.plugin_version,
        request.feature_instance_token,
    )?;
    if !operation_authorized(&owner, &request.service_id, &request.operation_id) {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let direction = jobs
        .file_grants()
        .grant_direction(
            &request.grant_id,
            &owner,
            &request.service_id,
            &request.operation_id,
        )
        .map_err(|_| command_error(FeatureServiceErrorCode::Unauthorized))?;
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    crate::external_services::start_service_job(
        &data_root,
        Arc::clone(&jobs),
        StartJobRequest {
            owner,
            service_id: request.service_id,
            operation_id: request.operation_id,
            idempotency_key: request.idempotency_key,
            grant_id: request.grant_id,
            direction,
            input: request.input,
        },
    )
    .await
    .map_err(map_job_error)
}

#[tauri::command]
pub async fn feature_service_job_availability<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<FeatureServiceJobRegistry>>,
    request: FeatureJobListCommandRequest,
) -> Result<FeatureJobAvailability, FeatureJobCommandError> {
    if window.label() != "main" {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let owner = command_owner(
        request.feature_id,
        request.plugin_version,
        request.feature_instance_token,
    )?;
    if !service_authorized(&owner, &request.service_id) {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let data_root = crate::core::app::commands::get_jan_data_folder_path(app);
    Ok(
        match crate::external_services::ensure_service_jobs_available(
            &data_root,
            &request.service_id,
            Arc::clone(&jobs),
        )
        .await
        {
            Ok(()) => FeatureJobAvailability {
                available: true,
                reason: None,
            },
            Err("incompatible") => FeatureJobAvailability {
                available: false,
                reason: Some("provider_v2_unavailable"),
            },
            Err(_) => FeatureJobAvailability {
                available: false,
                reason: Some("provider_unavailable"),
            },
        },
    )
}

#[tauri::command]
pub fn feature_service_job_get<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<FeatureServiceJobRegistry>>,
    request: FeatureJobIdentityCommandRequest,
) -> Result<JobSnapshot, FeatureJobCommandError> {
    if window.label() != "main" {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let owner = command_owner(
        request.feature_id,
        request.plugin_version,
        request.feature_instance_token,
    )?;
    let (service_id, operation_id) = jobs
        .job_authority(&owner, &request.job_id)
        .map_err(map_job_error)?;
    if !operation_authorized(&owner, &service_id, &operation_id) {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    jobs.snapshot(&owner, &request.job_id)
        .map_err(map_job_error)
}

#[tauri::command]
pub fn feature_service_job_events<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<FeatureServiceJobRegistry>>,
    request: FeatureJobEventsCommandRequest,
) -> Result<JobEventBatch, FeatureJobCommandError> {
    if window.label() != "main" {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let owner = command_owner(
        request.feature_id,
        request.plugin_version,
        request.feature_instance_token,
    )?;
    let (service_id, operation_id) = jobs
        .job_authority(&owner, &request.job_id)
        .map_err(map_job_error)?;
    if !operation_authorized(&owner, &service_id, &operation_id) {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    jobs.events(&owner, &request.job_id, request.after_sequence)
        .map_err(map_job_error)
}

#[tauri::command]
pub fn feature_service_job_list<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<FeatureServiceJobRegistry>>,
    request: FeatureJobListCommandRequest,
) -> Result<Vec<JobSnapshot>, FeatureJobCommandError> {
    if window.label() != "main" {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let owner = command_owner(
        request.feature_id,
        request.plugin_version,
        request.feature_instance_token,
    )?;
    if !service_authorized(&owner, &request.service_id) {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    jobs.list(&owner, &request.service_id)
        .map_err(map_job_error)
}

#[tauri::command]
pub async fn feature_service_job_cancel<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    jobs: tauri::State<'_, Arc<FeatureServiceJobRegistry>>,
    request: FeatureJobIdentityCommandRequest,
) -> Result<JobSnapshot, FeatureJobCommandError> {
    if window.label() != "main" {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let owner = command_owner(
        request.feature_id,
        request.plugin_version,
        request.feature_instance_token,
    )?;
    let (service_id, operation_id) = jobs
        .job_authority(&owner, &request.job_id)
        .map_err(map_job_error)?;
    if !operation_authorized(&owner, &service_id, &operation_id) {
        return Err(command_error(FeatureServiceErrorCode::Unauthorized));
    }
    let decision = jobs
        .cancel(&owner, &request.job_id)
        .map_err(map_job_error)?;
    if decision.provider_cancel_required {
        if let Err(code) =
            crate::external_services::cancel_service_job(&service_id, &request.job_id).await
        {
            let failure = crate::external_services::provider_error_code(code);
            let _ = jobs.fail(
                &request.job_id,
                failure,
                "The Provider could not cancel the job",
                true,
            );
        }
    }
    jobs.snapshot(&owner, &request.job_id)
        .map_err(map_job_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feature_file_grants::{FeatureFileGrantService, FileGrantDirection, FileGrantOwner};
    use serde_json::json;
    use std::{sync::Arc, time::Duration};

    fn owner(feature: &str, instance: &str) -> FileGrantOwner {
        FileGrantOwner {
            feature_id: feature.into(),
            feature_instance_id: instance.into(),
        }
    }

    fn registry(root: &std::path::Path) -> FeatureServiceJobRegistry {
        FeatureServiceJobRegistry::new(Arc::new(
            FeatureFileGrantService::new(root.to_path_buf()).unwrap(),
        ))
    }

    fn upload_request(
        registry: &FeatureServiceJobRegistry,
        root: &std::path::Path,
        owner: FileGrantOwner,
        key: &str,
        input: serde_json::Value,
    ) -> StartJobRequest {
        let source = root.join(format!("{}.agent", uuid::Uuid::new_v4()));
        std::fs::write(&source, b"agent-package").unwrap();
        let grant = registry
            .file_grants()
            .register_selected_path(
                owner.clone(),
                "store",
                "agents.upload.v1",
                FileGrantDirection::Upload,
                source,
            )
            .unwrap();
        StartJobRequest {
            owner,
            service_id: "store".into(),
            operation_id: "agents.upload.v1".into(),
            idempotency_key: key.into(),
            grant_id: grant.grant_id,
            direction: FileGrantDirection::Upload,
            input,
        }
    }

    fn download_request(
        registry: &FeatureServiceJobRegistry,
        target: &std::path::Path,
        owner: FileGrantOwner,
        key: &str,
    ) -> StartJobRequest {
        let grant = registry
            .file_grants()
            .register_selected_path(
                owner.clone(),
                "store",
                "agents.download.v1",
                FileGrantDirection::Download,
                target.to_path_buf(),
            )
            .unwrap();
        StartJobRequest {
            owner,
            service_id: "store".into(),
            operation_id: "agents.download.v1".into(),
            idempotency_key: key.into(),
            grant_id: grant.grant_id,
            direction: FileGrantDirection::Download,
            input: json!({"agentId":"writer"}),
        }
    }

    #[test]
    fn start_is_idempotent_and_conflicts_on_a_different_request() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request = upload_request(
            &registry,
            root.path(),
            owner("agent-hub", "instance-1"),
            "key-1",
            json!({"name":"writer"}),
        );

        let first = registry.start(request.clone()).unwrap();
        let retry = registry.start(request.clone()).unwrap();

        assert!(first.created);
        assert!(!retry.created);
        assert_eq!(first.snapshot.job_id, retry.snapshot.job_id);
        assert_eq!(registry.job_count(), 1);
        let ledger =
            std::fs::read_to_string(root.path().join("plugins/cleanup-ledger.json")).unwrap();
        assert!(ledger.contains("agent-hub"));
        assert_eq!(
            registry
                .start(StartJobRequest {
                    input: json!({"name":"different"}),
                    ..request
                })
                .unwrap_err(),
            JobError::IdempotencyConflict
        );
    }

    #[test]
    fn runs_through_one_terminal_with_monotonic_sequences() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request_owner = owner("agent-hub", "instance-1");
        let started = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "key-1",
                json!({}),
            ))
            .unwrap();
        let job_id = &started.snapshot.job_id;

        registry.mark_running(job_id).unwrap();
        registry.propose_result(job_id).unwrap();
        registry
            .succeed(job_id, json!({"agentId":"writer"}))
            .unwrap();
        assert!(!root.path().join("plugins/cleanup-ledger.json").exists());

        let batch = registry.events(&request_owner, job_id, 0).unwrap();
        assert_eq!(
            batch
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        assert_eq!(batch.snapshot.status, JobStatus::Succeeded);
        assert_eq!(
            registry.succeed(job_id, json!({})).unwrap_err(),
            JobError::Terminal
        );
    }

    #[test]
    fn arbitrates_queued_running_and_terminal_cancellation() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request_owner = owner("agent-hub", "instance-1");
        let queued = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "queued",
                json!({}),
            ))
            .unwrap();
        let decision = registry
            .cancel(&request_owner, &queued.snapshot.job_id)
            .unwrap();
        assert_eq!(decision.status, JobStatus::Cancelled);
        assert!(!decision.provider_cancel_required);

        let running = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "running",
                json!({}),
            ))
            .unwrap();
        registry.mark_running(&running.snapshot.job_id).unwrap();
        let decision = registry
            .cancel(&request_owner, &running.snapshot.job_id)
            .unwrap();
        assert_eq!(decision.status, JobStatus::CancelRequested);
        assert!(decision.provider_cancel_required);
        assert_eq!(
            registry
                .propose_result(&running.snapshot.job_id)
                .unwrap_err(),
            JobError::CancelRequested
        );
        registry
            .provider_cancelled(&running.snapshot.job_id)
            .unwrap();
        assert_eq!(
            registry
                .cancel(&request_owner, &running.snapshot.job_id)
                .unwrap_err(),
            JobError::TooLate
        );
    }

    #[test]
    fn cancellation_wins_before_the_download_publish_commit() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request_owner = owner("agent-hub", "instance-1");
        let target = root.path().join("download.agent");
        std::fs::write(&target, b"old-package").unwrap();
        let started = registry
            .start(download_request(
                &registry,
                &target,
                request_owner.clone(),
                "download",
            ))
            .unwrap();
        let job_id = &started.snapshot.job_id;
        let staged = started.staged.unwrap();
        std::fs::write(&staged.absolute_path, b"new-package").unwrap();
        let digest = format!("{:x}", Sha256::digest(b"new-package"));
        registry.mark_running(job_id).unwrap();
        registry.propose_result(job_id).unwrap();
        let prepared = registry
            .file_grants()
            .prepare_download(&staged.grant_id, 11, &digest)
            .unwrap();

        registry.cancel(&request_owner, job_id).unwrap();
        let finished = registry
            .complete_finalizing(job_id, Some(prepared), json!({}))
            .unwrap();

        assert_eq!(finished.status, JobStatus::Cancelled);
        assert_eq!(std::fs::read(&target).unwrap(), b"old-package");
    }

    #[test]
    fn subscription_resume_does_not_cancel_or_repeat_events() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request_owner = owner("agent-hub", "instance-1");
        let started = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "key-1",
                json!({}),
            ))
            .unwrap();
        let job_id = &started.snapshot.job_id;
        registry.mark_running(job_id).unwrap();
        let first = registry.events(&request_owner, job_id, 0).unwrap();
        assert_eq!(first.events.len(), 2);
        drop(first);

        registry.propose_result(job_id).unwrap();
        registry.succeed(job_id, json!({})).unwrap();
        let resumed = registry.events(&request_owner, job_id, 2).unwrap();
        assert_eq!(
            resumed
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![3, 4]
        );
    }

    #[test]
    fn keeps_latest_snapshot_and_signals_a_history_gap() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request_owner = owner("agent-hub", "instance-1");
        let started = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "key-1",
                json!({}),
            ))
            .unwrap();
        let job_id = &started.snapshot.job_id;
        registry.mark_running(job_id).unwrap();
        let base = std::time::Instant::now();
        for index in 0..257_u64 {
            registry
                .record_progress_at(
                    job_id,
                    index,
                    Some(300),
                    base + Duration::from_millis(index * 101),
                )
                .unwrap();
        }
        registry.propose_result(job_id).unwrap();
        registry.succeed(job_id, json!({"ok":true})).unwrap();

        let batch = registry.events(&request_owner, job_id, 0).unwrap();
        assert_eq!(batch.events.len(), 256);
        assert!(batch.has_gap);
        assert_eq!(batch.snapshot.status, JobStatus::Succeeded);
        assert_eq!(batch.events.last().unwrap().status, JobStatus::Succeeded);
    }

    #[test]
    fn isolates_owners_and_idempotency_namespaces() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let first_owner = owner("agent-hub", "instance-1");
        let second_owner = owner("other-hub", "instance-2");
        let first = registry
            .start(upload_request(
                &registry,
                root.path(),
                first_owner.clone(),
                "same-key",
                json!({}),
            ))
            .unwrap();
        let second = registry
            .start(upload_request(
                &registry,
                root.path(),
                second_owner.clone(),
                "same-key",
                json!({}),
            ))
            .unwrap();

        assert_ne!(first.snapshot.job_id, second.snapshot.job_id);
        assert_eq!(
            registry
                .snapshot(&second_owner, &first.snapshot.job_id)
                .unwrap_err(),
            JobError::NotFound
        );
        assert_eq!(
            registry
                .cancel(&second_owner, &first.snapshot.job_id)
                .unwrap_err(),
            JobError::NotFound
        );
        assert!(registry.list(&second_owner, "missing").unwrap().is_empty());
    }

    #[test]
    fn retains_only_the_latest_terminal_per_feature_and_service() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request_owner = owner("agent-hub", "instance-1");
        let first = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "first",
                json!({}),
            ))
            .unwrap();
        registry.mark_running(&first.snapshot.job_id).unwrap();
        registry.propose_result(&first.snapshot.job_id).unwrap();
        registry.succeed(&first.snapshot.job_id, json!({})).unwrap();

        let second = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "second",
                json!({}),
            ))
            .unwrap();
        registry.mark_running(&second.snapshot.job_id).unwrap();
        registry.propose_result(&second.snapshot.job_id).unwrap();
        registry
            .succeed(&second.snapshot.job_id, json!({}))
            .unwrap();

        assert_eq!(
            registry
                .snapshot(&request_owner, &first.snapshot.job_id)
                .unwrap_err(),
            JobError::NotFound
        );
        assert_eq!(
            registry
                .list(&request_owner, "store")
                .unwrap()
                .into_iter()
                .map(|job| job.job_id)
                .collect::<Vec<_>>(),
            vec![second.snapshot.job_id]
        );
    }

    #[test]
    fn busy_returns_the_active_snapshot_and_cleanup_invalidates_the_instance() {
        let root = tempfile::tempdir().unwrap();
        let registry = registry(root.path());
        let request_owner = owner("agent-hub", "instance-1");
        let first = registry
            .start(upload_request(
                &registry,
                root.path(),
                request_owner.clone(),
                "first",
                json!({}),
            ))
            .unwrap();
        let second = upload_request(
            &registry,
            root.path(),
            request_owner.clone(),
            "second",
            json!({}),
        );

        let JobError::Busy(snapshot) = registry.start(second).unwrap_err() else {
            panic!("expected busy")
        };
        assert_eq!(snapshot.job_id, first.snapshot.job_id);
        registry.cleanup_owner_instance(&request_owner);
        assert_eq!(registry.job_count(), 0);
    }

    #[test]
    fn a_new_registry_does_not_restore_old_jobs() {
        let root = tempfile::tempdir().unwrap();
        let job_registry = registry(root.path());
        let started = job_registry
            .start(upload_request(
                &job_registry,
                root.path(),
                owner("agent-hub", "instance-1"),
                "key-1",
                json!({}),
            ))
            .unwrap();
        assert_eq!(job_registry.job_count(), 1);
        drop(job_registry);

        let restarted = registry(root.path());
        assert_eq!(restarted.job_count(), 0);
        assert_eq!(
            restarted
                .snapshot(&owner("agent-hub", "instance-1"), &started.snapshot.job_id,)
                .unwrap_err(),
            JobError::NotFound
        );
    }
}
