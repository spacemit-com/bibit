pub const GATEWAY_TEST_URL: &str = "https://developer.bianbu.xyz/api-server";
pub const GATEWAY_PROD_URL: &str = "https://spacemit.com/api-server";
pub const DEFAULT_MODE: &str = "test";

pub fn resolve(mode: Option<&str>, custom_url: Option<&str>) -> Result<String, String> {
    if let Some(url) = custom_url {
        if url.trim().is_empty() {
            return Err("BIBIT_RAGFLOW_URL must not be empty".into());
        }
        return Ok(url.trim().trim_end_matches('/').into());
    }
    match mode.unwrap_or(DEFAULT_MODE) {
        "test" => Ok(GATEWAY_TEST_URL.into()),
        "prod" => Ok(GATEWAY_PROD_URL.into()),
        _ => Err("BIBIT_KNOWLEDGE_MODE must be test or prod".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_mode_resolution() {
        assert_eq!(resolve(None, None).unwrap(), GATEWAY_TEST_URL);
        assert_eq!(resolve(Some("test"), None).unwrap(), GATEWAY_TEST_URL);
        assert_eq!(resolve(Some("prod"), None).unwrap(), GATEWAY_PROD_URL);
        assert_eq!(
            resolve(Some("test"), Some("http://custom")).unwrap(),
            "http://custom"
        );
        assert!(resolve(Some("invalid"), None).is_err());
        assert!(resolve(None, Some("")).is_err());
        assert!(resolve(None, Some(" ")).is_err());
    }
}
