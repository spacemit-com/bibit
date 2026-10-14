pub fn should_verify(target_os: Option<&str>, profile: Option<&str>) -> bool {
    target_os == Some("linux") && profile == Some("release")
}

#[cfg(test)]
mod tests {
    use super::should_verify;

    #[test]
    fn verifies_linux_release_gui_artifacts() {
        assert!(should_verify(Some("linux"), Some("release")));
    }

    #[test]
    fn skips_non_release_profiles_used_by_tests_and_checks() {
        assert!(!should_verify(Some("linux"), Some("debug")));
        assert!(!should_verify(Some("linux"), Some("test")));
    }

    #[test]
    fn skips_non_linux_builds() {
        assert!(!should_verify(Some("macos"), Some("release")));
        assert!(!should_verify(Some("windows"), Some("release")));
    }
}
