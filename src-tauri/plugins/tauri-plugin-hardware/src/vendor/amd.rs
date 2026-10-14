use crate::types::{GpuInfo, GpuUsage};

impl GpuInfo {
    pub fn get_usage_amd(&self) -> GpuUsage {
        use std::fs;
        use std::path::Path;

        let device_id = match &self.vulkan_info {
            Some(vulkan_info) => vulkan_info.device_id,
            None => {
                log::error!("get_usage_amd called without Vulkan info");
                return self.get_usage_unsupported();
            }
        };

        let closure = || -> Result<GpuUsage, Box<dyn std::error::Error>> {
            for subdir in fs::read_dir("/sys/class/drm")? {
                let device_path = subdir?.path().join("device");

                // Check if this is an AMD GPU by looking for amdgpu directory
                if !device_path
                    .join("driver/module/drivers/pci:amdgpu")
                    .exists()
                {
                    continue;
                }

                // match device_id from Vulkan info
                let this_device_id_str = fs::read_to_string(device_path.join("device"))?;
                let this_device_id = u32::from_str_radix(
                    this_device_id_str
                        .strip_prefix("0x")
                        .unwrap_or(&this_device_id_str)
                        .trim(),
                    16,
                )?;
                if this_device_id != device_id {
                    continue;
                }

                let read_mem = |path: &Path| -> u64 {
                    fs::read_to_string(path)
                        .map(|content| content.trim().parse::<u64>().unwrap_or(0))
                        .unwrap_or(0)
                        / 1024
                        / 1024 // Convert bytes to MiB
                };
                return Ok(GpuUsage {
                    uuid: self.uuid.clone(),
                    total_memory: read_mem(&device_path.join("mem_info_vram_total")),
                    used_memory: read_mem(&device_path.join("mem_info_vram_used")),
                });
            }
            Err("GPU not found".to_string().into())
        };

        match closure() {
            Ok(usage) => usage,
            Err(e) => {
                log::error!(
                    "Failed to get memory usage for AMD GPU {:#x}: {}",
                    device_id,
                    e
                );
                self.get_usage_unsupported()
            }
        }
    }

}
