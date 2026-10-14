// App Configuration Constants
pub const CONFIGURATION_FILE_NAME: &str = "settings.json";

/// Tauri bundle `identifier` from `tauri.conf.json`. Used only as a fallback
/// source for legacy config recovery.
pub const TAURI_BUNDLE_IDENTIFIER: &str = "com.dc.bibit.gui";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tauri_bundle_identifier_is_stable() {
        assert_eq!(TAURI_BUNDLE_IDENTIFIER, "com.dc.bibit.gui");
    }
}
