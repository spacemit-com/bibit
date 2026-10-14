//! 最小未确认输入记录。落盘成功后才提交；接受后删除，不保存第二份对话历史。
use super::{RuntimeError, RuntimeErrorCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingInput {
    pub target_id: String,
    pub session_id: String,
    pub message_id: String,
    pub content: String,
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<super::SessionAttachmentRef>,
}

fn failure(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InternalError, message)
}

fn fingerprint(value: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in value {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn directory(root: &Path, target_id: &str, session_id: &str) -> PathBuf {
    root.join(fingerprint(&[target_id, session_id]))
}

fn record_path(root: &Path, target: &str, session: &str, message: &str) -> PathBuf {
    directory(root, target, session).join(format!("{}.json", fingerprint(&[message])))
}

fn read(path: &Path) -> Result<PendingInput, RuntimeError> {
    let data = fs::read(path).map_err(|_| failure("无法读取未确认输入，请保留记录并重试"))?;
    serde_json::from_slice(&data).map_err(|_| failure("未确认输入记录损坏，请保留原文件"))
}

fn sync_directory(path: &Path) -> Result<(), RuntimeError> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| failure("无法确认输入目录已持久化，尚未发送"))
}

fn same_request(path: &Path, input: &PendingInput) -> Result<(), RuntimeError> {
    if read(path)? == *input {
        return Ok(());
    }
    let mut error = RuntimeError::new(
        RuntimeErrorCode::RunConflict,
        "同一 message_id 的输入内容不同；修改正文后请使用新的消息标识",
    );
    error.recoverable = false;
    Err(error)
}

pub fn persist(root: &Path, input: &PendingInput) -> Result<(), RuntimeError> {
    if input.target_id.is_empty()
        || input.session_id.is_empty()
        || input.message_id.is_empty()
        || input.message_id.len() > 128
        || !input
            .message_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        || !(1..=16_000).contains(&input.content.chars().count())
        || input.skill_ids.len() > 100
        || input.skill_ids.iter().any(|id| id.trim().is_empty())
        || input.attachments.len() > 20
        || input
            .attachments
            .iter()
            .any(|item| item.resource_id.trim().is_empty())
    {
        let mut error =
            RuntimeError::new(RuntimeErrorCode::RunFailed, "输入标识、正文或技能参数无效");
        error.recoverable = false;
        return Err(error);
    }
    let dir = directory(root, &input.target_id, &input.session_id);
    fs::create_dir_all(&dir).map_err(|_| failure("无法建立输入恢复目录，尚未发送"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .and_then(|_| fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)))
            .map_err(|_| failure("无法保护输入恢复目录，尚未发送"))?;
    }
    let path = record_path(root, &input.target_id, &input.session_id, &input.message_id);
    if path.exists() {
        same_request(&path, input)?;
        // 上次发布后目录同步可能失败，重试不能仅凭文件存在就允许发送。
        for directory in dir.ancestors() {
            sync_directory(directory)?;
        }
        return Ok(());
    }
    let temporary = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| failure("无法保存输入恢复记录，尚未发送"))?;
        let data = serde_json::to_vec(input).map_err(|_| failure("无法编码输入恢复记录"))?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|_| failure("输入恢复记录未落盘，尚未发送"))?;
        // 同目录硬链接原子发布，不能覆盖另一窗口已保存的同 ID 负载。
        match fs::hard_link(&temporary, &path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                same_request(&path, input)?
            }
            Err(_) => return Err(failure("无法发布输入恢复记录，尚未发送")),
        }
        // create_dir_all 可能同时新建多层目录，逐层确认父目录项已落盘。
        for directory in dir.ancestors() {
            sync_directory(directory)?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub fn list(
    root: &Path,
    target_id: &str,
    session_id: &str,
) -> Result<Vec<PendingInput>, RuntimeError> {
    let dir = directory(root, target_id, session_id);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(failure("无法读取输入恢复目录")),
    };
    let mut records = Vec::new();
    for entry in entries {
        let path = entry.map_err(|_| failure("无法读取输入恢复记录"))?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let input = read(&path)?;
        if input.target_id != target_id || input.session_id != session_id {
            return Err(failure("输入恢复记录目标不匹配"));
        }
        records.push(input);
    }
    records.sort_by(|a, b| a.message_id.cmp(&b.message_id));
    Ok(records)
}

pub fn remove(
    root: &Path,
    target_id: &str,
    session_id: &str,
    message_id: &str,
) -> Result<(), RuntimeError> {
    let path = record_path(root, target_id, session_id, message_id);
    match fs::remove_file(&path) {
        Ok(()) => sync_directory(&directory(root, target_id, session_id)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(failure(
            "输入已接收，但本地恢复记录未清理；重试时保留原消息标识",
        )),
    }
}

/// 可信 Session 历史和实时事件均可确认已接收输入；普通 token 不触碰磁盘。
pub fn confirm_events(
    root: &Path,
    target_id: &str,
    session_id: &str,
    events: &[serde_json::Value],
) -> Result<(), RuntimeError> {
    for event in events {
        let message_id = match event["type"].as_str() {
            Some("user/message") => event["data"]["message_id"].as_str(),
            Some("agent/inbox/spliced") => event["data"]["message"]["message_id"].as_str(),
            _ => None,
        };
        if let Some(message_id) = message_id.filter(|id| !id.is_empty()) {
            remove(root, target_id, session_id, message_id)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_events_clear_only_matching_target_session_and_message() {
        let root = std::env::temp_dir().join(format!("bibit-pending-{}", uuid::Uuid::new_v4()));
        let input = PendingInput {
            target_id: "target-a".into(),
            session_id: "session-a".into(),
            message_id: "accepted".into(),
            content: "恢复输入".into(),
            skill_ids: vec![],
            attachments: vec![],
        };
        let unknown = PendingInput {
            message_id: "unknown".into(),
            ..input.clone()
        };
        let other_target = PendingInput {
            target_id: "target-b".into(),
            ..input.clone()
        };
        let other_session = PendingInput {
            session_id: "session-b".into(),
            ..input.clone()
        };
        for record in [&unknown, &other_target, &other_session] {
            persist(&root, record).unwrap();
        }
        for event in [
            serde_json::json!({"seq": 0, "type": "user/message", "data": {"message_id": "accepted"}}),
            serde_json::json!({"seq": 1, "type": "agent/inbox/spliced", "data": {"message": {"message_id": "accepted"}}}),
        ] {
            persist(&root, &input).unwrap();
            confirm_events(&root, "target-a", "session-a", &[event]).unwrap();
            assert_eq!(
                list(&root, "target-a", "session-a").unwrap(),
                vec![unknown.clone()]
            );
            assert_eq!(
                list(&root, "target-b", "session-a").unwrap(),
                vec![other_target.clone()]
            );
            assert_eq!(
                list(&root, "target-a", "session-b").unwrap(),
                vec![other_session.clone()]
            );
        }
        // 类型相似、字段错误或仅引用 ID 的事件不是接收凭据。
        confirm_events(&root, "target-a", "session-a", &[
            serde_json::json!({"type": "agent/inbox/claimed", "data": {"message_id": "unknown"}}),
            serde_json::json!({"type": "user/message", "data": {"message": {"message_id": "unknown"}}}),
            serde_json::json!({"type": "agent/inbox/spliced", "data": {"message_id": "unknown"}}),
            serde_json::json!({"type": "user/message", "data": {"message_id": "not-local"}}),
        ]).unwrap();
        assert_eq!(list(&root, "target-a", "session-a").unwrap(), vec![unknown]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_input_is_idempotent_and_isolated() {
        let root = std::env::temp_dir().join(format!("bibit-pending-{}", uuid::Uuid::new_v4()));
        let input = PendingInput {
            target_id: "target-a".into(),
            session_id: "same-session".into(),
            message_id: "message-1".into(),
            content: "恢复输入".into(),
            skill_ids: vec!["skill".into()],
            attachments: vec![],
        };
        persist(&root, &input).unwrap();
        persist(&root, &input).unwrap();
        assert_eq!(
            list(&root, "target-a", "same-session").unwrap(),
            vec![input.clone()]
        );
        assert!(list(&root, "target-b", "same-session").unwrap().is_empty());
        let mut changed = input.clone();
        changed.content = "不同内容".into();
        assert_eq!(
            persist(&root, &changed).unwrap_err().code,
            RuntimeErrorCode::RunConflict
        );
        assert_eq!(
            list(&root, "target-a", "same-session").unwrap(),
            vec![input]
        );
        remove(&root, "target-a", "same-session", "message-1").unwrap();
        assert!(list(&root, "target-a", "same-session").unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
