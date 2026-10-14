use std::path::PathBuf;

pub struct VectorDBState {
    pub base_dir: PathBuf,
}

impl Default for VectorDBState {
    fn default() -> Self {
        Self::new()
    }
}

impl VectorDBState {
    pub fn new() -> Self {
        let base = product_database_dir(
            dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")),
        );
        std::fs::create_dir_all(&base).ok();
        Self { base_dir: base }
    }
}

fn product_database_dir(data_dir: PathBuf) -> PathBuf {
    data_dir.join("BiBit").join("data").join("db")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_database_path_is_isolated_under_bibit() {
        let root = PathBuf::from("/tmp/app-data");
        assert_eq!(
            product_database_dir(root),
            PathBuf::from("/tmp/app-data/BiBit/data/db")
        );
    }
}
