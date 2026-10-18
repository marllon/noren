//! Noren core library. Kept free of Tauri so it can be tested on its own.

/// Returns the product name.
pub fn name() -> &'static str {
    "noren"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_noren() {
        assert_eq!(name(), "noren");
    }
}
