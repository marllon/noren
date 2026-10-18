//! Detection against the real machine. Needs at least one shell, which every
//! supported system has.

use noren_core::{Platform, SystemEnv, detect_profiles, detect_system_profiles};

#[test]
fn real_machine_lists_a_profile_and_the_default_exists() {
    let set = detect_system_profiles();
    for profile in &set.profiles {
        eprintln!(
            "profile {} -> {} {:?}",
            profile.id, profile.program, profile.args
        );
    }
    assert!(!set.profiles.is_empty(), "no shell profile detected");

    let default = set
        .default_profile()
        .expect("default profile is in the list");
    eprintln!("default: {}", default.id);
    assert!(
        std::path::Path::new(&default.program).is_file(),
        "default program does not exist: {}",
        default.program
    );

    let mut ids: Vec<&str> = set.profiles.iter().map(|p| p.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), set.profiles.len(), "profile ids must be unique");
}

#[test]
fn real_detection_is_repeatable() {
    let first = detect_profiles(&SystemEnv, Platform::current());
    let second = detect_profiles(&SystemEnv, Platform::current());
    assert_eq!(first, second);
}
