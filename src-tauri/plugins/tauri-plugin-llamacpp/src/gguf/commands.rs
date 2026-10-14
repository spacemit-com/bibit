use super::types::GgufMetadata;
use super::utils::{estimate_kv_cache_internal, read_gguf_metadata_internal};
use crate::gguf::types::{KVCacheError, KVCacheEstimate, ModelSupportStatus};
use std::collections::HashMap;
use std::fs;
use tauri_plugin_hardware::get_system_info;

/// Read GGUF metadata from a model file
#[tauri::command]
pub async fn read_gguf_metadata(path: String) -> Result<GgufMetadata, String> {
    read_gguf_metadata_internal(path).await
}

#[tauri::command]
pub async fn estimate_kv_cache_size(
    meta: HashMap<String, String>,
    ctx_size: Option<u64>,
) -> Result<KVCacheEstimate, KVCacheError> {
    estimate_kv_cache_internal(meta, ctx_size).await
}

#[tauri::command]
pub async fn get_model_size(path: String) -> Result<u64, String> {
    if path.starts_with("https://") {
        // Handle remote URL
        let client = reqwest::Client::new();
        let response = client
            .head(&path)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch HEAD request: {}", e))?;

        if let Some(content_length) = response.headers().get("content-length") {
            let content_length_str = content_length
                .to_str()
                .map_err(|e| format!("Invalid content-length header: {}", e))?;
            content_length_str
                .parse::<u64>()
                .map_err(|e| format!("Failed to parse content-length: {}", e))
        } else {
            Ok(0)
        }
    } else {
        // Handle local file using standard fs
        let metadata =
            fs::metadata(&path).map_err(|e| format!("Failed to get file metadata: {}", e))?;
        Ok(metadata.len())
    }
}

#[tauri::command]
pub async fn is_model_supported(
    path: String,
    ctx_size: Option<u32>,
) -> Result<ModelSupportStatus, String> {
    // Get model size
    let model_size = get_model_size(path.clone()).await?;

    // Get system info
    let system_info = get_system_info();

    log::info!("modelSize: {}", model_size);

    // Read GGUF metadata
    let gguf = read_gguf_metadata(path.clone()).await?;

    // Calculate KV cache size
    let kv_cache_size = if let Some(ctx_size) = ctx_size {
        log::info!("Using ctx_size: {}", ctx_size);
        estimate_kv_cache_internal(gguf.metadata, Some(ctx_size as u64))
            .await
            .map_err(|e| e.to_string())?
            .size
    } else {
        estimate_kv_cache_internal(gguf.metadata, None)
            .await
            .map_err(|e| e.to_string())?
            .size
    };

    // Multimodal projector lives next to model.gguf as mmproj.gguf and is
    // loaded into the same device alongside the weights + KV cache. Only
    // inspected for local paths — remote URLs route through the importer
    // and won't hit this branch with the final on-disk layout.
    let mmproj_size: u64 = if path.starts_with("https://") {
        0
    } else {
        std::path::Path::new(&path)
            .parent()
            .map(|d| d.join("mmproj.gguf"))
            .and_then(|p| fs::metadata(&p).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    };
    if mmproj_size > 0 {
        log::info!("mmprojSize: {}", mmproj_size);
    }

    // Total memory consumption = model weights + kvcache + mmproj
    let total_required = model_size + kv_cache_size + mmproj_size;
    log::info!(
        "isModelSupported: Total memory requirement: {} for {}; kvCacheSize: {}, mmprojSize: {}",
        total_required,
        path,
        kv_cache_size,
        mmproj_size
    );

    const RESERVE_BYTES: u64 = 2_288_490_189; // ~2.13 GB driver/runtime overhead

    let total_system_memory: u64 = match system_info.gpus.is_empty() {
        // No GPU: treat all RAM as the execution pool, no separate system bucket
        true => 0,
        false => system_info.total_memory * 1024 * 1024,
    };

    // Calculate total VRAM from all GPUs
    let total_vram: u64 = match system_info.gpus.is_empty() {
        true => {
            log::info!("No GPUs detected, using total RAM as VRAM");
            system_info.total_memory * 1024 * 1024
        }
        false => system_info
            .gpus
            .iter()
            .map(|g| g.total_memory * 1024 * 1024)
            .sum::<u64>(),
    };

    log::info!("Total VRAM reported/calculated (in bytes): {}", total_vram);

    let usable_vram = total_vram.saturating_sub(RESERVE_BYTES);

    let usable_total_memory = if total_system_memory > RESERVE_BYTES {
        (total_system_memory - RESERVE_BYTES) + usable_vram
    } else {
        usable_vram
    };
    log::info!("System RAM: {} bytes", total_system_memory);
    log::info!("Total VRAM: {} bytes", total_vram);
    log::info!("Usable total memory: {} bytes", usable_total_memory);
    log::info!("Usable VRAM: {} bytes", usable_vram);
    log::info!("Required: {} bytes", total_required);

    // Check if model fits in total memory at all (this is the hard limit)
    if total_required > usable_total_memory {
        return Ok(ModelSupportStatus::Red); // Truly impossible to run
    }

    // Check if everything fits in VRAM (ideal case — pure GPU execution)
    if total_required <= usable_vram {
        return Ok(ModelSupportStatus::Green);
    }

    // Fits in combined RAM+VRAM but not entirely in VRAM: CPU-GPU hybrid scenario
    Ok(ModelSupportStatus::Yellow)
}
