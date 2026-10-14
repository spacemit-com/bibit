//! Runtime 生命周期管理器：发现、切换、并向外暴露当前活动的 gateway。

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};

use super::gateway::{MinimalRuntimeGateway, RuntimeEventSink};
use super::registry::{self, RuntimeContext, RuntimeDescriptor};
use super::{RuntimeError, RuntimeSnapshot};

pub struct RuntimeManager {
    sink: Arc<dyn RuntimeEventSink>,
    context: RuntimeContext,
    active: RwLock<Option<Arc<MinimalRuntimeGateway>>>,
    switch_lock: Mutex<()>,
}

impl RuntimeManager {
    /// 按默认 profile 构造初始 gateway，保持与 `production_default` 兼容。
    pub fn new(
        sink: Arc<dyn RuntimeEventSink>,
        runtime_cwd: PathBuf,
    ) -> Result<Arc<Self>, RuntimeError> {
        let context = RuntimeContext { runtime_cwd };
        let spec = registry::spec_for(registry::default_profile_id())
            .ok_or_else(|| registry::unknown_runtime(registry::default_profile_id()))?;
        let driver = (spec.factory)(&context)?;
        let gateway = Arc::new(
            MinimalRuntimeGateway::new(driver, sink.clone())
                .with_receipt_store(context.runtime_cwd.join("permission-receipts.json")),
        );
        Ok(Arc::new(Self {
            sink,
            context,
            active: RwLock::new(Some(gateway)),
            switch_lock: Mutex::new(()),
        }))
    }

    pub async fn active_gateway(&self) -> Result<Arc<MinimalRuntimeGateway>, RuntimeError> {
        self.active.read().await.clone().ok_or_else(|| {
            super::RuntimeError::new(
                super::RuntimeErrorCode::InternalError,
                "Runtime not initialized",
            )
        })
    }

    /// 探测所有注册后端的可接入性；只 `check()`，不启动任何进程。
    pub async fn discover(&self) -> Vec<RuntimeDescriptor> {
        let mut descriptors = Vec::with_capacity(registry::REGISTRY.len());
        for spec in registry::REGISTRY {
            match (spec.factory)(&self.context) {
                Ok(driver) => {
                    let available = driver.check().await.is_ok();
                    descriptors.push(RuntimeDescriptor {
                        id: spec.id,
                        display_name: spec.display_name,
                        available,
                        capabilities: driver.capabilities(),
                        error: None,
                    });
                }
                Err(error) => descriptors.push(RuntimeDescriptor {
                    id: spec.id,
                    display_name: spec.display_name,
                    available: false,
                    capabilities: Default::default(),
                    error: Some(error.message),
                }),
            }
        }
        descriptors
    }

    /// 停止旧 gateway，构造并启动新 gateway；新 gateway 是全新 state，epoch 自然更换。
    pub async fn switch(&self, id: &str) -> Result<RuntimeSnapshot, RuntimeError> {
        let _guard = self.switch_lock.lock().await;
        let spec = registry::spec_for(id).ok_or_else(|| registry::unknown_runtime(id))?;

        let previous = self.active.read().await.clone();
        if let Some(old) = &previous {
            let _ = old.stop().await;
        }

        let driver = (spec.factory)(&self.context)?;
        let gateway = Arc::new(
            MinimalRuntimeGateway::new(driver, self.sink.clone())
                .with_receipt_store(self.context.runtime_cwd.join("permission-receipts.json")),
        );
        *self.active.write().await = Some(gateway.clone());

        match gateway.start().await {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                *self.active.write().await = previous.clone();
                if let Some(old) = previous {
                    let _ = old.start().await;
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::gateway::RuntimeEventSink;
    use super::super::RuntimeEventEnvelope;
    use super::*;

    struct NoopSink;

    impl RuntimeEventSink for NoopSink {
        fn emit(&self, _event: &RuntimeEventEnvelope) -> Result<(), super::super::RuntimeError> {
            Ok(())
        }
    }

    fn manager() -> Arc<RuntimeManager> {
        let cwd = std::env::temp_dir().join("bibit-manager-test");
        RuntimeManager::new(Arc::new(NoopSink), cwd).unwrap()
    }

    #[tokio::test]
    async fn discover_returns_every_registered_runtime() {
        let descriptors = manager().discover().await;
        let ids: Vec<&str> = descriptors.iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["bianbu", "hermes"]);
        assert!(descriptors.iter().all(|d| !d.display_name.is_empty()));
    }

    #[tokio::test]
    async fn switch_failure_restores_previous_gateway() {
        struct FailingSink;
        impl RuntimeEventSink for FailingSink {
            fn emit(&self, _: &RuntimeEventEnvelope) -> Result<(), RuntimeError> {
                Err(RuntimeError::new(
                    super::super::RuntimeErrorCode::InternalError,
                    "test sink failure",
                ))
            }
        }
        let cwd = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(FailingSink), cwd.path().into()).unwrap();
        let previous = manager.active_gateway().await.unwrap();
        let error = manager.switch("bianbu").await.unwrap_err();
        assert!(!error.message.is_empty());
        assert!(Arc::ptr_eq(
            &previous,
            &manager.active_gateway().await.unwrap()
        ));
    }

    #[tokio::test]
    async fn switch_to_unknown_runtime_is_rejected() {
        let error = manager().switch("nope").await.unwrap_err();
        assert!(error.message.contains("unknown runtime id"));
    }
}
