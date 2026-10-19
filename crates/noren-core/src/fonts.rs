//! The fonts installed on the machine, without any Tauri dependency: the families of the
//! monospaced ones, for the settings of the terminal (`terminal.font.family`).
//!
//! Only reads: the folders where the system keeps its fonts are scanned (`fontdb` does it, with the
//! known folders of Windows, macOS and Linux plus the fonts of the user) and nothing is written or
//! installed. A font file is only parsed for its names and its flags, never drawn.
//!
//! The names come from files that anybody may have put in a font folder, so they are not trusted:
//! only a name that is the name of a font family gets through (letters, digits, spaces and a few
//! signs, the same rule the page applies with `fontFamilyProblem`), which leaves out anything that
//! could be read as markup, a quote, a semicolon or an address.

use fontdb::{Database, FaceInfo};

/// The longest family name listed, in characters. The same limit as the page's.
pub const MAX_FONT_NAME_CHARS: usize = 64;

/// Whether `name` is the name of a font family: 1 to [`MAX_FONT_NAME_CHARS`] characters, the first
/// a letter or a digit, the others letters, digits, spaces or one of `_ . + & -`.
pub fn is_font_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    name.chars().count() <= MAX_FONT_NAME_CHARS
        && first.is_alphanumeric()
        && chars.all(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '.' | '+' | '&' | '-'))
}

/// The names of the monospaced families among `faces`, each once (upper and lower case alike), in
/// alphabetical order. A face is monospaced when its font says so (the `isFixedPitch` flag of the
/// `post` table); its family is the first name the font gives, which is the English one when the
/// font has it. The several faces of a family (regular, bold, italic) make one name.
pub fn monospace_families<'a>(faces: impl IntoIterator<Item = &'a FaceInfo>) -> Vec<String> {
    let mut found: Vec<(String, String)> = faces
        .into_iter()
        .filter(|face| face.monospaced)
        .filter_map(|face| face.families.first())
        .map(|(name, _language)| name.trim())
        .filter(|name| is_font_name(name))
        .map(|name| (name.to_lowercase(), name.to_owned()))
        .collect();
    found.sort();
    found.dedup_by(|a, b| a.0 == b.0);
    found.into_iter().map(|(_, name)| name).collect()
}

/// The monospaced font families installed on this machine, in alphabetical order. A machine with
/// no fonts in the folders that are scanned answers an empty list.
pub fn list_monospace_families() -> Vec<String> {
    let mut fonts = Database::new();
    fonts.load_system_fonts();
    monospace_families(fonts.faces())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use fontdb::{ID, Language, Source, Stretch, Style, Weight};

    use super::*;

    fn face(family: &str, monospaced: bool) -> FaceInfo {
        FaceInfo {
            id: ID::dummy(),
            source: Source::Binary(Arc::new(Vec::<u8>::new())),
            index: 0,
            families: vec![(family.to_owned(), Language::English_UnitedStates)],
            post_script_name: family.replace(' ', ""),
            style: Style::Normal,
            weight: Weight::NORMAL,
            stretch: Stretch::Normal,
            monospaced,
        }
    }

    fn names(faces: &[FaceInfo]) -> Vec<String> {
        monospace_families(faces)
    }

    #[test]
    fn a_font_name_has_letters_digits_spaces_and_a_few_signs() {
        for name in [
            "Consolas",
            "Cascadia Mono",
            "M+ 1m",
            "Noto Sans Mono CJK JP",
            "Source Code Pro",
            "Fira Code-Retina",
            "ＭＳ ゴシック",
            "3270 Nerd Font",
            "A&B_c.d",
        ] {
            assert!(is_font_name(name), "{name:?} should be a font name");
        }
    }

    #[test]
    fn what_could_be_markup_or_an_address_is_not_a_font_name() {
        for name in [
            "",
            " Consolas",
            "-Consolas",
            "Evil\"Font",
            "Evil'Font",
            "a;b",
            "a{b}",
            "url(http://example.com/x.woff)",
            "https://example.com/x",
            "a\\b",
            "a/b",
            "a<b>",
            "line\nbreak",
            "tab\there",
            "a,b",
        ] {
            assert!(!is_font_name(name), "{name:?} should not be a font name");
        }
        assert!(is_font_name(&"x".repeat(MAX_FONT_NAME_CHARS)));
        assert!(!is_font_name(&"x".repeat(MAX_FONT_NAME_CHARS + 1)));
    }

    #[test]
    fn only_monospaced_faces_are_listed() {
        let faces = [
            face("Consolas", true),
            face("Segoe UI", false),
            face("Courier New", true),
        ];
        assert_eq!(names(&faces), ["Consolas", "Courier New"]);
    }

    #[test]
    fn the_faces_of_a_family_make_one_name() {
        let faces = [
            face("Consolas", true),
            face("Consolas", true),
            face("consolas", true),
        ];
        assert_eq!(names(&faces), ["Consolas"]);
    }

    #[test]
    fn names_come_back_in_alphabetical_order_whatever_the_case() {
        let faces = [
            face("dejaVu Sans Mono", true),
            face("Consolas", true),
            face("Cascadia Mono", true),
            face("Courier New", true),
        ];
        assert_eq!(
            names(&faces),
            [
                "Cascadia Mono",
                "Consolas",
                "Courier New",
                "dejaVu Sans Mono"
            ]
        );
    }

    #[test]
    fn a_name_that_is_not_a_font_name_is_left_out() {
        let faces = [
            face("Consolas", true),
            face("x\"; background: url(http://example.com)", true),
            face("", true),
            face("  ", true),
        ];
        assert_eq!(names(&faces), ["Consolas"]);
    }

    #[test]
    fn the_first_name_of_the_font_is_its_family() {
        let mut japanese = face("MS Gothic", true);
        japanese
            .families
            .push(("ＭＳ ゴシック".to_owned(), Language::Japanese_Japan));
        assert_eq!(names(&[japanese]), ["MS Gothic"]);
    }

    #[test]
    fn no_faces_is_no_names() {
        assert!(names(&[]).is_empty());
    }

    // Windows and macOS ship monospaced fonts (Consolas and Courier New, Menlo and Courier), so on
    // them the scan of the system folders must find some. A Linux machine may have no fonts at all
    // (a server, a container), so there the list only has to be well formed.
    #[test]
    fn this_machine_has_monospaced_fonts() {
        let families = list_monospace_families();
        // Shown with `--nocapture`: what the scan found on the machine that ran the test.
        eprintln!(
            "{} monospaced families: {}",
            families.len(),
            families.join(", ")
        );
        if cfg!(any(windows, target_os = "macos")) {
            assert!(
                !families.is_empty(),
                "no monospaced font family was found on this machine"
            );
        }
        for family in &families {
            assert!(is_font_name(family), "{family:?} is not a font name");
        }
        let mut sorted = families.clone();
        sorted.sort_by_key(|name| name.to_lowercase());
        assert_eq!(families, sorted);
    }
}
