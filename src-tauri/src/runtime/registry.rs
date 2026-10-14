//! 静态 Runtime 后端注册表。
//!
//! 新增后端 = 在此加一个 `RuntimeDriverSpec` 并实现 `RuntimeDriver`，
//! 不改 gateway 编排与前端核心。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use super::bianbu_http::BianbuHttpDriver;
use super::contract::RuntimeCapabilities;
use super::driver::RuntimeDriver;
use super::hermes_acp::HermesAcpDriver;
use super::{RuntimeError, RuntimeErrorCode};

#[derive(Clone, Debug)]
pub struct RuntimeContext {
    pub runtime_cwd: PathBuf,
}

pub struct RuntimeDriverSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub factory: fn(&RuntimeContext) -> Result<Arc<dyn RuntimeDriver>, RuntimeError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    pub available: bool,
    pub capabilities: RuntimeCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub static REGISTRY: &[RuntimeDriverSpec] = &[
    RuntimeDriverSpec {
        id: "bianbu",
        display_name: "Bianbu Runtime",
        factory: |_| Ok(Arc::new(BianbuHttpDriver::from_env()?)),
    },
    RuntimeDriverSpec {
        id: "hermes",
        display_name: "Hermes",
        factory: |context| {
            Ok(Arc::new(HermesAcpDriver::production(
                context.runtime_cwd.clone(),
            )))
        },
    },
];

pub fn default_profile_id() -> &'static str {
    "bianbu"
}

pub fn spec_for(id: &str) -> Option<&'static RuntimeDriverSpec> {
    REGISTRY.iter().find(|spec| spec.id == id)
}

pub fn unknown_runtime(id: &str) -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InternalError,
        format!("unknown runtime id {id}"),
    )
}
