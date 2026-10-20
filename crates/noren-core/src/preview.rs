//! Reading a file for a preview pane, without any Tauri dependency: markdown, JSON and plain text as
//! text, or a picture as bytes, or the reason the file is not shown.
//!
//! The interface asks for a full path (`Backend.readFilePreview`) and shows what comes back; this
//! side is the one that opens the file, so it checks again what `previewPathProblem` of
//! `@noren/model` checks (the two are tested with the same cases):
//!
//! - **The path.** It must be a full path of this computer. An empty or overlong path, one with a
//!   control character, a relative one, and a network or device path (`\\server\share`, `\\?\`,
//!   `//host`: opening one would reach another machine) are refused before anything is opened.
//! - **The file.** It must be a regular file; a folder, a pipe or a device is refused and never
//!   read. Its first bytes decide what it is: those of a png, jpeg, gif or webp picture (the name
//!   is not trusted), else text. Text is at most [`MAX_PREVIEW_TEXT_BYTES`] and has no NUL byte;
//!   a picture is at most [`MAX_PREVIEW_IMAGE_BYTES`]. The kind of text comes from the extension
//!   (`.md`, `.json`, anything else is plain). A UTF-8 byte order mark is dropped and bytes that
//!   are not UTF-8 become U+FFFD.
//!
//! Nothing is written and nothing is fetched. A refusal is an answer, not an error: the pane tells
//! the person why.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use crate::mods::is_reserved_name;

/// The largest text file read (1 MiB).
pub const MAX_PREVIEW_TEXT_BYTES: u64 = 1024 * 1024;

/// The largest picture file read (10 MiB).
pub const MAX_PREVIEW_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// The longest path accepted, counted in UTF-16 units like the interface counts it.
pub const MAX_PREVIEW_PATH: usize = 4096;

/// How many leading bytes tell the pictures apart.
const SIGNATURE_BYTES: usize = 12;

/// The longest system message kept for an unreadable file.
const MAX_DETAIL_CHARS: usize = 500;

/// The pictures a preview shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewImage {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl PreviewImage {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }
}

/// The picture the first bytes of a file are, or `None` when they are none of the four.
pub fn sniff_preview_image(bytes: &[u8]) -> Option<PreviewImage> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some(PreviewImage::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(PreviewImage::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(PreviewImage::Gif)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(PreviewImage::Webp)
    } else {
        None
    }
}

/// What a text file is, by its extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextKind {
    Markdown,
    Json,
    Text,
}

impl TextKind {
    /// The word the interface uses for the kind.
    pub fn name(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Json => "json",
            Self::Text => "text",
        }
    }
}

/// The last part of `path`, split at `/` and `\` alike (empty parts do not count).
fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

/// The kind of text the file at `path` is by its name; `.md` and the like are markdown, `.json` is
/// JSON, everything else is plain text.
pub fn text_kind_of(path: &str) -> TextKind {
    let name = file_name(path);
    let extension = match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_ascii_lowercase(),
        _ => String::new(),
    };
    match extension.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => TextKind::Markdown,
        "json" => TextKind::Json,
        _ => TextKind::Text,
    }
}

/// Why a file is not shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewRefusal {
    /// The path is not a full path of this computer.
    Relative,
    /// The path is a network or device path.
    Network,
    /// The path is empty, too long or has a control character.
    InvalidPath,
    /// The path is a folder.
    Directory,
    /// Nothing is at the path.
    Missing,
    /// The file has a NUL byte and is not a picture the preview knows.
    Binary,
    /// More than the limit for what the file is (text or picture): its size in bytes.
    TooLarge { size: u64 },
    /// The system refused to read it, or it is not a regular file: what it said.
    Unreadable(String),
}

impl PreviewRefusal {
    /// The word the interface uses for the reason (`PREVIEW_REFUSALS` of `@noren/model`).
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Relative => "relative",
            Self::Network => "network",
            Self::InvalidPath => "invalid",
            Self::Directory => "directory",
            Self::Missing => "missing",
            Self::Binary => "binary",
            Self::TooLarge { .. } => "too-large",
            Self::Unreadable(_) => "unreadable",
        }
    }
}

/// What reading a file for a preview gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilePreview {
    /// Markdown, JSON or plain text, as the text of the file.
    Text { kind: TextKind, text: String },
    /// A picture: its kind and the bytes of the file.
    Image { kind: PreviewImage, bytes: Vec<u8> },
    /// The file is not shown.
    Refused(PreviewRefusal),
}

impl FilePreview {
    /// The answer as one frame, the way the page reads it (`decodeFilePreview` of `@noren/model`):
    /// four bytes (big endian) with the length of the header, the header (JSON in UTF-8), and the
    /// body. A picture of megabytes is the body as it is; it never goes through JSON.
    ///
    /// - text: `{"kind":"markdown"|"json"|"text"}`, body the text;
    /// - picture: `{"kind":"image","mime":"image/png"|...}`, body the file;
    /// - refusal: `{"kind":"refused","reason":...}` with `"size"` for a file too large and
    ///   `"detail"` for an unreadable one, and no body.
    pub fn to_frame(&self) -> Vec<u8> {
        let (header, body): (serde_json::Value, &[u8]) = match self {
            Self::Text { kind, text } => {
                (serde_json::json!({ "kind": kind.name() }), text.as_bytes())
            }
            Self::Image { kind, bytes } => (
                serde_json::json!({ "kind": "image", "mime": kind.mime() }),
                bytes,
            ),
            Self::Refused(refusal) => {
                let mut header =
                    serde_json::json!({ "kind": "refused", "reason": refusal.reason() });
                match refusal {
                    PreviewRefusal::TooLarge { size } => header["size"] = (*size).into(),
                    PreviewRefusal::Unreadable(detail) => {
                        header["detail"] = detail
                            .chars()
                            .take(MAX_DETAIL_CHARS)
                            .collect::<String>()
                            .into();
                    }
                    _ => {}
                }
                (header, &[])
            }
        };
        let head = header.to_string().into_bytes();
        let mut frame = Vec::with_capacity(4 + head.len() + body.len());
        // A header is a few dozen bytes, far from `u32::MAX`.
        frame.extend_from_slice(&u32::try_from(head.len()).unwrap_or(u32::MAX).to_be_bytes());
        frame.extend_from_slice(&head);
        frame.extend_from_slice(body);
        frame
    }
}

fn refuse(refusal: PreviewRefusal) -> FilePreview {
    FilePreview::Refused(refusal)
}

fn unreadable(error: &io::Error) -> FilePreview {
    refuse(PreviewRefusal::Unreadable(error.to_string()))
}

/// Whether `path` starts at a drive root: a letter, a colon and a separator.
fn has_drive_root(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(d), Some(':'), Some('/' | '\\')) if d.is_ascii_alphabetic()
    )
}

/// The refusal for a path that is not a full local path, or `None` when it is one. The same rules
/// as `classifyPreviewPath` of `@noren/model`, and then the one thing only this side knows: whether
/// the system takes it for absolute (`/home/me` is not a path on Windows, and `C:\Users` is not on
/// Linux).
pub(crate) fn path_refusal(path: &str) -> Option<PreviewRefusal> {
    if path.trim().is_empty()
        || path.encode_utf16().count() > MAX_PREVIEW_PATH
        || path.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Some(PreviewRefusal::InvalidPath);
    }
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Some(PreviewRefusal::Network);
    }
    if !(has_drive_root(path) || path.starts_with('/')) || !Path::new(path).is_absolute() {
        return Some(PreviewRefusal::Relative);
    }
    None
}

/// Reads the file at `path` for a preview. See the top of this file for what is shown and what is
/// refused.
pub fn read_file_preview(path: &str) -> FilePreview {
    if let Some(refusal) = path_refusal(path) {
        return refuse(refusal);
    }
    // `CON`, `NUL` and the other names Windows reserves open a device whatever the folder is, and
    // reading one can wait for ever.
    if cfg!(windows) && is_reserved_name(file_name(path)) {
        return refuse(PreviewRefusal::Unreadable(
            "the name is one Windows keeps for a device".to_owned(),
        ));
    }
    let file_path = Path::new(path);
    let metadata = match fs::metadata(file_path) {
        Ok(metadata) => metadata,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return refuse(PreviewRefusal::Missing);
        }
        Err(error) => return unreadable(&error),
    };
    if metadata.is_dir() {
        return refuse(PreviewRefusal::Directory);
    }
    // A pipe or a device would wait for ever for a writer or never end.
    if !metadata.is_file() {
        return refuse(PreviewRefusal::Unreadable(
            "it is not a regular file".to_owned(),
        ));
    }
    let size = metadata.len();
    if size > MAX_PREVIEW_IMAGE_BYTES {
        return refuse(PreviewRefusal::TooLarge { size });
    }
    let mut file = match File::open(file_path) {
        Ok(file) => file,
        Err(error) => return unreadable(&error),
    };
    let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    if let Err(error) = (&mut file)
        .take(SIGNATURE_BYTES as u64)
        .read_to_end(&mut bytes)
    {
        return unreadable(&error);
    }
    let image = sniff_preview_image(&bytes);
    let limit = if image.is_some() {
        MAX_PREVIEW_IMAGE_BYTES
    } else {
        MAX_PREVIEW_TEXT_BYTES
    };
    if size > limit {
        return refuse(PreviewRefusal::TooLarge { size });
    }
    // One byte past the limit: a file that grew since `metadata` is still caught.
    let rest = limit + 1 - bytes.len() as u64;
    if let Err(error) = (&mut file).take(rest).read_to_end(&mut bytes) {
        return unreadable(&error);
    }
    if bytes.len() as u64 > limit {
        return refuse(PreviewRefusal::TooLarge {
            size: bytes.len() as u64,
        });
    }
    if let Some(kind) = image {
        return FilePreview::Image { kind, bytes };
    }
    if bytes.contains(&0) {
        return refuse(PreviewRefusal::Binary);
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
    FilePreview::Text {
        kind: text_kind_of(path),
        text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A folder under the system temp dir with a unique name, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir()
                .join(format!("noren-preview-{}-{nanos}-{n}", std::process::id()));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        /// Writes `bytes` to `name` in the folder and returns its full path as text.
        fn write(&self, name: &str, bytes: &[u8]) -> String {
            let file = self.0.join(name);
            fs::write(&file, bytes).expect("write the file");
            file.display().to_string()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0, 0x10, b'J', b'F', b'I', b'F'];
    const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00";
    const WEBP: &[u8] = b"RIFF\x00\x00\x00\x00WEBPVP8 ";

    fn text_of(preview: FilePreview) -> (TextKind, String) {
        match preview {
            FilePreview::Text { kind, text } => (kind, text),
            other => panic!("not text: {other:?}"),
        }
    }

    fn refusal_of(preview: FilePreview) -> PreviewRefusal {
        match preview {
            FilePreview::Refused(refusal) => refusal,
            other => panic!("not refused: {other:?}"),
        }
    }

    #[test]
    fn shows_markdown_json_and_text_by_the_name_of_the_file() {
        let dir = TempDir::new();
        let cases = [
            ("notes.md", TextKind::Markdown),
            ("NOTES.MD", TextKind::Markdown),
            ("a.markdown", TextKind::Markdown),
            ("a.mdown", TextKind::Markdown),
            ("a.mkd", TextKind::Markdown),
            ("data.json", TextKind::Json),
            ("DATA.Json", TextKind::Json),
            ("log.txt", TextKind::Text),
            ("Makefile", TextKind::Text),
            ("a.jsonl", TextKind::Text),
            (".md", TextKind::Text),
            ("a.md.bak", TextKind::Text),
            ("icon.svg", TextKind::Text),
        ];
        for (name, kind) in cases {
            let path = dir.write(name, b"content \xc3\xa9");
            assert_eq!(
                text_of(read_file_preview(&path)),
                (kind, "content \u{e9}".to_owned()),
                "{name}"
            );
        }
    }

    #[test]
    fn shows_an_empty_file_as_empty_text() {
        let dir = TempDir::new();
        let path = dir.write("empty.txt", b"");
        assert_eq!(
            text_of(read_file_preview(&path)),
            (TextKind::Text, String::new())
        );
    }

    #[test]
    fn shows_each_picture_by_its_bytes_whatever_the_name_says() {
        let dir = TempDir::new();
        for (name, bytes, kind) in [
            ("a.png", PNG, PreviewImage::Png),
            ("b.jpg", JPEG, PreviewImage::Jpeg),
            ("c.gif", GIF, PreviewImage::Gif),
            ("d.webp", WEBP, PreviewImage::Webp),
            ("noext", PNG, PreviewImage::Png),
            ("looks-like-text.md", JPEG, PreviewImage::Jpeg),
            ("looks-like-text.json", GIF, PreviewImage::Gif),
        ] {
            let path = dir.write(name, bytes);
            assert_eq!(
                read_file_preview(&path),
                FilePreview::Image {
                    kind,
                    bytes: bytes.to_vec()
                },
                "{name}"
            );
        }
        assert_eq!(PreviewImage::Png.mime(), "image/png");
        assert_eq!(PreviewImage::Jpeg.mime(), "image/jpeg");
        assert_eq!(PreviewImage::Gif.mime(), "image/gif");
        assert_eq!(PreviewImage::Webp.mime(), "image/webp");
    }

    #[test]
    fn a_name_like_a_picture_on_a_file_that_is_not_one_is_text() {
        let dir = TempDir::new();
        for content in ["not a picture", "<svg/>", "%PDF-1.7"] {
            let path = dir.write("fake.png", content.as_bytes());
            assert_eq!(
                text_of(read_file_preview(&path)),
                (TextKind::Text, content.to_owned())
            );
        }
        // A bmp is a picture elsewhere in the app but not here; its bytes hold NULs.
        let path = dir.write("map.bmp", b"BM\x00\x00\x00\x00");
        assert_eq!(refusal_of(read_file_preview(&path)), PreviewRefusal::Binary);
    }

    #[test]
    fn drops_a_byte_order_mark_and_mends_bytes_that_are_not_utf8() {
        let dir = TempDir::new();
        let path = dir.write("bom.txt", b"\xef\xbb\xbfhello");
        assert_eq!(text_of(read_file_preview(&path)).1, "hello");
        let path = dir.write("latin.txt", b"caf\xe9");
        assert_eq!(text_of(read_file_preview(&path)).1, "caf\u{fffd}");
    }

    #[test]
    fn refuses_a_file_with_a_nul_byte_wherever_it_is() {
        let dir = TempDir::new();
        let path = dir.write("prog.exe", b"MZ\x00\x01");
        assert_eq!(refusal_of(read_file_preview(&path)), PreviewRefusal::Binary);
        let mut late = vec![b'a'; 100_000];
        late.push(0);
        let path = dir.write("late.txt", &late);
        assert_eq!(refusal_of(read_file_preview(&path)), PreviewRefusal::Binary);
        // UTF-16 text has NULs between its letters.
        let path = dir.write("wide.txt", b"h\x00i\x00");
        assert_eq!(refusal_of(read_file_preview(&path)), PreviewRefusal::Binary);
    }

    #[test]
    fn limits_text_to_one_mib_and_a_picture_to_ten() {
        let dir = TempDir::new();
        let at_limit = vec![b'a'; MAX_PREVIEW_TEXT_BYTES as usize];
        let path = dir.write("limit.txt", &at_limit);
        assert_eq!(text_of(read_file_preview(&path)).1.len(), at_limit.len());

        let over = vec![b'a'; MAX_PREVIEW_TEXT_BYTES as usize + 1];
        let path = dir.write("over.txt", &over);
        assert_eq!(
            refusal_of(read_file_preview(&path)),
            PreviewRefusal::TooLarge {
                size: MAX_PREVIEW_TEXT_BYTES + 1
            }
        );

        let picture = |size: u64| {
            let mut bytes = vec![0u8; size as usize];
            bytes[..PNG.len()].copy_from_slice(PNG);
            bytes
        };
        // A picture may be larger than text may, up to its own limit.
        let path = dir.write("mid.png", &picture(MAX_PREVIEW_TEXT_BYTES + 1));
        assert!(matches!(
            read_file_preview(&path),
            FilePreview::Image { .. }
        ));
        let path = dir.write("limit.png", &picture(MAX_PREVIEW_IMAGE_BYTES));
        assert!(matches!(
            read_file_preview(&path),
            FilePreview::Image { .. }
        ));
        let path = dir.write("over.png", &picture(MAX_PREVIEW_IMAGE_BYTES + 1));
        assert_eq!(
            refusal_of(read_file_preview(&path)),
            PreviewRefusal::TooLarge {
                size: MAX_PREVIEW_IMAGE_BYTES + 1
            }
        );
    }

    #[test]
    fn says_too_large_before_binary() {
        let dir = TempDir::new();
        let path = dir.write("big.bin", &vec![0u8; MAX_PREVIEW_TEXT_BYTES as usize + 1]);
        assert!(matches!(
            refusal_of(read_file_preview(&path)),
            PreviewRefusal::TooLarge { .. }
        ));
    }

    #[test]
    fn refuses_a_folder_and_nothing_there() {
        let dir = TempDir::new();
        assert_eq!(
            refusal_of(read_file_preview(&dir.0.display().to_string())),
            PreviewRefusal::Directory
        );
        let missing = dir.0.join("none.md").display().to_string();
        assert_eq!(
            refusal_of(read_file_preview(&missing)),
            PreviewRefusal::Missing
        );
        // A file where a folder was expected is nothing at that path too.
        let file = dir.write("file.txt", b"x");
        let below = format!("{file}{}inner.txt", std::path::MAIN_SEPARATOR);
        assert_eq!(
            refusal_of(read_file_preview(&below)),
            PreviewRefusal::Missing
        );
    }

    #[test]
    fn refuses_a_path_that_is_not_a_full_local_path_before_opening_anything() {
        for path in [
            "notes.md",
            "./notes.md",
            "../notes.md",
            "docs/notes.md",
            "~/notes.md",
            "C:notes.md",
            "\\notes.md",
            "https://example.com/a.md",
            "file:///C:/a.md",
        ] {
            assert_eq!(
                refusal_of(read_file_preview(path)),
                PreviewRefusal::Relative,
                "{path:?}"
            );
        }
        for path in [
            "\\\\server\\share\\a.md",
            "//server/share/a.md",
            "\\\\?\\C:\\a.md",
            "\\\\.\\pipe\\x",
            "//",
        ] {
            assert_eq!(
                refusal_of(read_file_preview(path)),
                PreviewRefusal::Network,
                "{path:?}"
            );
        }
        for path in [
            "",
            "   ",
            "\t",
            "/a\nb",
            "/a\0b",
            "/a\u{7f}b",
            "C:\\a\u{1b}[0m",
        ] {
            assert_eq!(
                refusal_of(read_file_preview(path)),
                PreviewRefusal::InvalidPath,
                "{path:?}"
            );
        }
        let long = format!("/{}", "a".repeat(MAX_PREVIEW_PATH));
        assert_eq!(
            refusal_of(read_file_preview(&long)),
            PreviewRefusal::InvalidPath
        );
    }

    #[test]
    fn a_path_in_the_style_of_another_system_is_not_one_here() {
        let other = if cfg!(windows) {
            "/home/me/notes.md"
        } else {
            "C:\\Users\\me\\notes.md"
        };
        assert_eq!(
            refusal_of(read_file_preview(other)),
            PreviewRefusal::Relative
        );
    }

    #[test]
    fn a_name_windows_keeps_for_a_device_is_never_opened() {
        if !cfg!(windows) {
            return;
        }
        for path in ["C:\\nul", "C:\\Temp\\CON.txt", "C:\\aux", "D:\\x\\com1.log"] {
            assert!(
                matches!(
                    refusal_of(read_file_preview(path)),
                    PreviewRefusal::Unreadable(_)
                ),
                "{path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn never_reads_a_pipe_or_a_device() {
        for path in ["/dev/null", "/dev/zero"] {
            assert!(
                matches!(
                    refusal_of(read_file_preview(path)),
                    PreviewRefusal::Unreadable(_)
                ),
                "{path}"
            );
        }
    }

    #[test]
    fn says_what_the_system_said_when_it_cannot_read() {
        // A file another program holds open without sharing is the one case every system
        // reports as a refusal to read; where it cannot be made, the check is the type of answer.
        let error = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(
            unreadable(&error),
            FilePreview::Refused(PreviewRefusal::Unreadable("denied".to_owned()))
        );
    }

    #[test]
    fn the_reasons_are_the_words_of_the_interface() {
        let reasons = [
            (PreviewRefusal::Relative, "relative"),
            (PreviewRefusal::Network, "network"),
            (PreviewRefusal::InvalidPath, "invalid"),
            (PreviewRefusal::Directory, "directory"),
            (PreviewRefusal::Missing, "missing"),
            (PreviewRefusal::Binary, "binary"),
            (PreviewRefusal::TooLarge { size: 1 }, "too-large"),
            (PreviewRefusal::Unreadable(String::new()), "unreadable"),
        ];
        for (refusal, word) in reasons {
            assert_eq!(refusal.reason(), word);
        }
    }

    /// Splits a frame into its header (as JSON) and its body.
    fn split(frame: &[u8]) -> (serde_json::Value, &[u8]) {
        let length = u32::from_be_bytes(frame[..4].try_into().expect("four bytes")) as usize;
        let header = serde_json::from_slice(&frame[4..4 + length]).expect("a JSON header");
        (header, &frame[4 + length..])
    }

    #[test]
    fn frames_text_as_a_header_and_the_text() {
        let frame = FilePreview::Text {
            kind: TextKind::Markdown,
            text: "# h\u{e9}".to_owned(),
        }
        .to_frame();
        // The exact bytes the page is tested against: 19 bytes of header, then the text.
        assert_eq!(&frame[..4], &[0, 0, 0, 19]);
        assert_eq!(&frame[4..23], br#"{"kind":"markdown"}"#.as_slice());
        let (header, body) = split(&frame);
        assert_eq!(header, serde_json::json!({ "kind": "markdown" }));
        assert_eq!(body, "# h\u{e9}".as_bytes());
    }

    #[test]
    fn frames_a_picture_as_a_header_and_the_file_itself() {
        let frame = FilePreview::Image {
            kind: PreviewImage::Png,
            bytes: PNG.to_vec(),
        }
        .to_frame();
        let (header, body) = split(&frame);
        assert_eq!(
            header,
            serde_json::json!({ "kind": "image", "mime": "image/png" })
        );
        assert_eq!(body, PNG);
    }

    #[test]
    fn frames_a_refusal_with_its_size_or_its_detail_and_no_body() {
        let cases = [
            (
                PreviewRefusal::Missing,
                serde_json::json!({ "kind": "refused", "reason": "missing" }),
            ),
            (
                PreviewRefusal::TooLarge { size: 2_097_152 },
                serde_json::json!({ "kind": "refused", "reason": "too-large", "size": 2_097_152 }),
            ),
            (
                PreviewRefusal::Unreadable("denied".to_owned()),
                serde_json::json!({ "kind": "refused", "reason": "unreadable", "detail": "denied" }),
            ),
        ];
        for (refusal, expected) in cases {
            let frame = FilePreview::Refused(refusal).to_frame();
            let (header, body) = split(&frame);
            assert_eq!(header, expected);
            assert!(body.is_empty());
        }
    }

    #[test]
    fn cuts_a_long_message_of_the_system() {
        let frame = FilePreview::Refused(PreviewRefusal::Unreadable("x".repeat(5000))).to_frame();
        let (header, _) = split(&frame);
        assert_eq!(
            header["detail"].as_str().map(str::len),
            Some(MAX_DETAIL_CHARS)
        );
    }
}
