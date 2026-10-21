//! The memory of the machine, for choosing a local model that fits it: the total RAM and, when it
//! can be known, the video memory (VRAM) of the graphics card.
//!
//! The reading sits behind the [`HardwareSource`] trait, so the tests feed the values they made up
//! (the same way [`crate::agents::ProcessSource`] does for the process tree). The real source
//! ([`SystemHardware`]) asks `sysinfo` for the RAM and `nvidia-smi` for the VRAM.
//!
//! The VRAM is the one that cannot be had everywhere: the system gives no portable way to ask for
//! it, and no crate in the tree reads it. `nvidia-smi` ships with the driver of NVIDIA cards, so
//! when it is there it is asked (`--query-gpu=memory.total`); with no such program, or no such
//! card, or an answer that makes no sense, the VRAM is `None`, which the model catalog reads as
//! "use the RAM". A card of another make, or the memory a computer shares between the processor
//! and the screen, is `None` as well.
//!
//! Nothing here fails: every problem is a missing value. A value is kept only when it is a whole
//! number of bytes above 0 that a JavaScript number holds exactly (at most 2^53 - 1), which is what
//! the page checks too.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use sysinfo::System;

/// The largest number of bytes kept: 2^53 - 1, the last whole number a JavaScript number holds
/// exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_EXACT_BYTES: u64 = (1 << 53) - 1;

/// How long `nvidia-smi` may take. It answers in well under a second; a driver that hangs must not
/// hang the screen that asked.
pub const VRAM_TIMEOUT: Duration = Duration::from_secs(3);

/// Most bytes read from the output of the program. One line per card is a few bytes.
const MAX_OUTPUT_BYTES: u64 = 4096;

/// The memory of this machine, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hardware {
    /// The RAM the system has, above 0 and at most [`MAX_EXACT_BYTES`].
    pub ram_bytes: u64,
    /// The video memory of the graphics card, or `None` when it is not known.
    pub vram_bytes: Option<u64>,
}

/// Where the numbers come from.
pub trait HardwareSource {
    /// The total RAM in bytes, or `None` when the system would not say.
    fn total_ram_bytes(&self) -> Option<u64>;
    /// The video memory in bytes, or `None` when it is not known.
    fn total_vram_bytes(&self) -> Option<u64>;
}

/// `bytes` when it is a value worth keeping: above 0 and at most [`MAX_EXACT_BYTES`].
fn valid_bytes(bytes: Option<u64>) -> Option<u64> {
    bytes.filter(|&b| b > 0 && b <= MAX_EXACT_BYTES)
}

/// Reads the memory from `source`. A RAM that is missing, 0 or past [`MAX_EXACT_BYTES`] is no
/// reading at all (`None`: without the RAM nothing can be recommended); a VRAM that is missing, 0
/// or past it is `vram_bytes: None`.
pub fn read_hardware(source: &dyn HardwareSource) -> Option<Hardware> {
    Some(Hardware {
        ram_bytes: valid_bytes(source.total_ram_bytes())?,
        vram_bytes: valid_bytes(source.total_vram_bytes()),
    })
}

/// Reads the memory of this machine with [`SystemHardware`].
pub fn read_system_hardware() -> Option<Hardware> {
    read_hardware(&SystemHardware::new())
}

/// The arguments that make `nvidia-smi` print the memory of each card in MiB, one per line, with
/// no header and no unit.
const NVIDIA_SMI_ARGS: &[&str] = &["--query-gpu=memory.total", "--format=csv,noheader,nounits"];

/// The memory of this machine, read with `sysinfo` (RAM) and `nvidia-smi` (VRAM).
#[derive(Debug, Clone)]
pub struct SystemHardware {
    nvidia_smi: String,
    timeout: Duration,
}

impl Default for SystemHardware {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemHardware {
    pub fn new() -> Self {
        Self {
            nvidia_smi: "nvidia-smi".to_owned(),
            timeout: VRAM_TIMEOUT,
        }
    }

    /// The same, asking `program` for the VRAM instead of `nvidia-smi` (for the tests).
    pub fn with_nvidia_smi(program: impl Into<String>, timeout: Duration) -> Self {
        Self {
            nvidia_smi: program.into(),
            timeout,
        }
    }
}

impl HardwareSource for SystemHardware {
    fn total_ram_bytes(&self) -> Option<u64> {
        let mut system = System::new();
        system.refresh_memory();
        Some(system.total_memory())
    }

    fn total_vram_bytes(&self) -> Option<u64> {
        let text = run_capped(&self.nvidia_smi, NVIDIA_SMI_ARGS, self.timeout)?;
        parse_nvidia_smi_memory(&text)
    }
}

const MIB: u64 = 1024 * 1024;

/// The VRAM in bytes from what `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`
/// prints: one whole number of MiB per line, one line per card. With several cards the largest
/// one counts, because a model that needs more than one card has to be split across them and
/// that is slower; the recommendation should not promise what one card cannot hold.
///
/// Anything that is not that is `None`: an empty text, a line that is not digits only (`N/A`,
/// `[Not Supported]`, a sign, a fraction, an error message), a card with 0 MiB, a number whose
/// size in bytes is past [`MAX_EXACT_BYTES`]. One bad line makes the whole text `None`: a program
/// that prints nonsense on one line is not trusted on the others.
pub fn parse_nvidia_smi_memory(text: &str) -> Option<u64> {
    let mut largest: Option<u64> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !line.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let mib: u64 = line.parse().ok()?;
        let bytes = valid_bytes(mib.checked_mul(MIB))?;
        largest = Some(largest.map_or(bytes, |current| current.max(bytes)));
    }
    largest
}

/// Runs `program` with `args` and returns what it printed on its standard output, as text, when it
/// ended with success within `timeout`. Everything else (the program is not there, it fails, it
/// takes too long and is killed, it prints something that is not text) is `None`.
///
/// The program gets no input and its error output goes nowhere. On Windows it starts with no
/// console window. At most [`MAX_OUTPUT_BYTES`] of the output are read.
fn run_capped(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW`: `nvidia-smi.exe` is a console program, and one started by a program
        /// with a window would open a console window unless told not to.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    // The output is read on its own thread so a program that fills the pipe and waits cannot make
    // this wait forever: the deadline below kills it either way.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    if !status.success() {
        return None;
    }
    let left = deadline.saturating_duration_since(Instant::now());
    let bytes = receiver
        .recv_timeout(left.max(Duration::from_millis(100)))
        .ok()?;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source with the numbers the test chose.
    struct Fake {
        ram: Option<u64>,
        vram: Option<u64>,
    }

    impl HardwareSource for Fake {
        fn total_ram_bytes(&self) -> Option<u64> {
            self.ram
        }
        fn total_vram_bytes(&self) -> Option<u64> {
            self.vram
        }
    }

    const GIB: u64 = 1024 * 1024 * 1024;

    fn read(ram: Option<u64>, vram: Option<u64>) -> Option<Hardware> {
        read_hardware(&Fake { ram, vram })
    }

    #[test]
    fn the_reading_carries_the_ram_and_the_vram_of_the_source() {
        assert_eq!(
            read(Some(16 * GIB), Some(8 * GIB)),
            Some(Hardware {
                ram_bytes: 16 * GIB,
                vram_bytes: Some(8 * GIB)
            })
        );
    }

    #[test]
    fn an_unknown_vram_is_none_and_the_ram_is_still_read() {
        assert_eq!(
            read(Some(32 * GIB), None),
            Some(Hardware {
                ram_bytes: 32 * GIB,
                vram_bytes: None
            })
        );
    }

    #[test]
    fn an_invalid_vram_becomes_none() {
        for vram in [0, MAX_EXACT_BYTES + 1, u64::MAX] {
            assert_eq!(
                read(Some(8 * GIB), Some(vram)),
                Some(Hardware {
                    ram_bytes: 8 * GIB,
                    vram_bytes: None
                }),
                "vram {vram}"
            );
        }
    }

    #[test]
    fn the_largest_exact_number_is_kept() {
        assert_eq!(
            read(Some(MAX_EXACT_BYTES), Some(MAX_EXACT_BYTES)),
            Some(Hardware {
                ram_bytes: MAX_EXACT_BYTES,
                vram_bytes: Some(MAX_EXACT_BYTES)
            })
        );
    }

    #[test]
    fn an_invalid_ram_is_no_reading() {
        for ram in [None, Some(0), Some(MAX_EXACT_BYTES + 1), Some(u64::MAX)] {
            assert_eq!(read(ram, Some(8 * GIB)), None, "ram {ram:?}");
        }
    }

    #[test]
    fn nvidia_smi_prints_mib_one_card_per_line() {
        assert_eq!(parse_nvidia_smi_memory("8192\n"), Some(8192 * MIB));
        assert_eq!(parse_nvidia_smi_memory("8192\r\n"), Some(8192 * MIB));
        assert_eq!(parse_nvidia_smi_memory("  24576  \n"), Some(24576 * MIB));
        assert_eq!(parse_nvidia_smi_memory("8192"), Some(8192 * MIB));
        // The largest card counts.
        assert_eq!(
            parse_nvidia_smi_memory("8192\n24576\n12288\n"),
            Some(24576 * MIB)
        );
        // Blank lines are not cards.
        assert_eq!(parse_nvidia_smi_memory("\n8192\n\n"), Some(8192 * MIB));
    }

    #[test]
    fn nvidia_smi_text_that_is_not_memory_is_none() {
        for text in [
            "",
            "\n",
            "   ",
            "N/A",
            "[N/A]",
            "[Not Supported]",
            "8192 MiB",
            "8192.5",
            "-8192",
            "+8192",
            "0x2000",
            "1e4",
            "0",
            "0\n",
            "00",
            "abc",
            "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.",
            "No devices were found",
            // One bad line spoils the others.
            "8192\nN/A\n",
            "8192\n0\n",
            // A number past what a JavaScript number holds, in bytes and as digits.
            "9007199254740992",
            "8589934593",
            "99999999999999999999999999",
            "٨١٩٢",
        ] {
            assert_eq!(parse_nvidia_smi_memory(text), None, "{text:?}");
        }
    }

    #[test]
    fn the_largest_number_of_mib_that_fits_is_kept() {
        let mib = MAX_EXACT_BYTES / MIB;
        assert_eq!(parse_nvidia_smi_memory(&mib.to_string()), Some(mib * MIB));
        assert_eq!(parse_nvidia_smi_memory(&(mib + 1).to_string()), None);
    }

    #[test]
    fn the_ram_of_this_machine_is_read() {
        let hardware = read_system_hardware().expect("the RAM of this machine");
        assert!(hardware.ram_bytes > 0);
        assert!(hardware.ram_bytes <= MAX_EXACT_BYTES);
        // The VRAM depends on the machine: with it, it is a valid number.
        if let Some(vram) = hardware.vram_bytes {
            assert!(vram > 0 && vram <= MAX_EXACT_BYTES);
        }
        // Printed so a run shows what this machine reported (`cargo test -- --nocapture`).
        println!(
            "hardware of this machine: ram {} bytes, vram {:?}",
            hardware.ram_bytes, hardware.vram_bytes
        );
    }

    #[test]
    fn a_missing_nvidia_smi_is_no_vram() {
        let source = SystemHardware::with_nvidia_smi(
            "noren-test-no-such-program-nvidia-smi",
            Duration::from_secs(1),
        );
        assert_eq!(source.total_vram_bytes(), None);
        // The RAM does not depend on it.
        let hardware = read_hardware(&source).expect("the RAM");
        assert_eq!(hardware.vram_bytes, None);
        assert!(hardware.ram_bytes > 0);
    }

    /// A program that is on every machine of the system the test runs on, with arguments.
    fn shell(script: &str) -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            ("cmd", vec!["/C".to_owned(), script.to_owned()])
        } else {
            ("sh", vec!["-c".to_owned(), script.to_owned()])
        }
    }

    fn run(script: &str, timeout: Duration) -> Option<String> {
        let (program, args) = shell(script);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run_capped(program, &args, timeout)
    }

    #[test]
    fn a_program_that_prints_is_read() {
        let text = run("echo 8192", Duration::from_secs(10)).expect("the output");
        assert_eq!(parse_nvidia_smi_memory(&text), Some(8192 * MIB));
    }

    #[test]
    fn a_program_that_fails_is_no_output() {
        assert_eq!(run("echo 8192 && exit 3", Duration::from_secs(10)), None);
    }

    #[test]
    fn a_program_that_takes_too_long_is_killed() {
        let script = if cfg!(windows) {
            "ping -n 20 127.0.0.1 > nul"
        } else {
            "sleep 20"
        };
        let started = Instant::now();
        assert_eq!(run(script, Duration::from_millis(300)), None);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "waited {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn output_that_is_not_text_is_no_output() {
        let script = if cfg!(windows) {
            // No portable way to print a stray byte with cmd: print nothing.
            "rem"
        } else {
            "printf '\\377\\376'"
        };
        let text = run(script, Duration::from_secs(10));
        if cfg!(windows) {
            assert_eq!(text.as_deref().map(str::trim), Some(""));
        } else {
            assert_eq!(text, None);
        }
    }
}
