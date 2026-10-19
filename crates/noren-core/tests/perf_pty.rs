//! Throughput of the real PTY (NOR-F11-01a). The shell prints a file of about 50 MB (the `cat` of
//! the spec, section 11) and the test times it from the spawn to the exit event, counting the bytes
//! and the batches the pump delivers.
//!
//! It is `#[ignore]`: it takes tens of seconds and the numbers depend on the machine, so it must
//! not run in `pnpm verify`. Run it with:
//!
//! ```text
//! cargo test -p noren-core --release --test perf_pty -- --ignored --nocapture
//! ```
//!
//! `NOREN_PERF_MB` (default 50) sets the size of the file, `NOREN_PERF_REPS` (default 5) the
//! number of repetitions, `NOREN_PERF_PRODUCER` the program that prints it and
//! `NOREN_PERF_LINE_BYTES` (default 0: the bare numbers `seq` prints) pads each line to that width. It prints one `PERF pty ...` line per repetition and the summary
//! (median and spread) that `docs/PERF.md` quotes. The only assertions are loose, so a slow
//! machine does not turn a measurement into a failure: all bytes arrive and the session ends.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use noren_core::{SessionEvent, SessionManager, SpawnSpec};

const DEFAULT_MB: usize = 50;
const DEFAULT_REPS: usize = 5;
/// A repetition that takes longer than this is a hang, not a slow machine.
const REP_TIMEOUT: Duration = Duration::from_secs(180);

/// A file of `bytes` bytes made of the lines `1`, `2`, `3`... (what `seq` prints), removed on drop.
struct BigFile {
    path: PathBuf,
}

impl BigFile {
    fn create(bytes: usize, line_width: usize) -> Self {
        let path = std::env::temp_dir().join(format!("noren-perf-{}.txt", std::process::id()));
        let mut out = BufWriter::new(File::create(&path).expect("create the temporary file"));
        let mut written = 0;
        let mut n: u64 = 1;
        while written < bytes {
            let line = format!("{n:<line_width$}\r\n");
            out.write_all(line.as_bytes()).expect("write");
            written += line.len();
            n += 1;
        }
        out.flush().expect("flush");
        BigFile { path }
    }
}

impl Drop for BigFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The program that prints the file, chosen by `NOREN_PERF_PRODUCER`. The PTY is the same; what
/// changes is how the program writes to it (a line at a time or in big buffers).
///
/// - `type` (default on Windows): `cmd.exe /c type FILE`
/// - `cat` (default elsewhere): `cat FILE`; on Windows the `cat.exe` of Git for Windows
fn print_spec(path: &std::path::Path) -> SpawnSpec {
    let producer = std::env::var("NOREN_PERF_PRODUCER").unwrap_or_default();
    let file = path.display().to_string();
    let (program, args): (String, Vec<String>) = match producer.as_str() {
        "cat" if cfg!(windows) => (
            r"C:\Program Files\Git\usr\bin\cat.exe".to_owned(),
            vec![file],
        ),
        _ if cfg!(windows) => (
            "cmd.exe".to_owned(),
            vec!["/c".to_owned(), "type".to_owned(), file],
        ),
        _ => ("cat".to_owned(), vec![file]),
    };
    SpawnSpec {
        program,
        args,
        cwd: None,
        env: vec![],
        cols: 120,
        rows: 30,
    }
}

#[derive(Default)]
struct Stats {
    bytes: usize,
    batches: usize,
    first: Option<Instant>,
    last: Option<Instant>,
    longest_gap: Duration,
    exited: bool,
}

struct Rep {
    seconds: f64,
    mb_per_s: f64,
    bytes: usize,
    batches: usize,
    first_ms: f64,
    longest_gap_ms: f64,
}

fn run_once(path: &std::path::Path) -> Rep {
    let manager = SessionManager::new();
    let stats = Arc::new(Mutex::new(Stats::default()));
    let sink = Arc::clone(&stats);
    let started = Instant::now();
    manager
        .spawn(print_spec(path), move |event| {
            let now = Instant::now();
            let mut s = sink.lock().unwrap();
            match event {
                SessionEvent::Output(bytes) => {
                    if let Some(last) = s.last {
                        s.longest_gap = s.longest_gap.max(now - last);
                    }
                    s.first.get_or_insert(now);
                    s.last = Some(now);
                    s.bytes += bytes.len();
                    s.batches += 1;
                }
                SessionEvent::Exit(_) => s.exited = true,
            }
        })
        .expect("spawn");
    loop {
        if stats.lock().unwrap().exited {
            break;
        }
        assert!(
            started.elapsed() < REP_TIMEOUT,
            "the session did not end in {REP_TIMEOUT:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let seconds = started.elapsed().as_secs_f64();
    manager.shutdown();
    let s = stats.lock().unwrap();
    Rep {
        seconds,
        mb_per_s: s.bytes as f64 / (1024.0 * 1024.0) / seconds,
        bytes: s.bytes,
        batches: s.batches,
        first_ms: s
            .first
            .map_or(0.0, |t| (t - started).as_secs_f64() * 1000.0),
        longest_gap_ms: s.longest_gap.as_secs_f64() * 1000.0,
    }
}

fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

/// Width of each line of the file: `NOREN_PERF_LINE_BYTES`, default 0 (the bare numbers `seq` prints).
fn line_width() -> usize {
    std::env::var("NOREN_PERF_LINE_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

/// The same file read straight from `portable-pty`, with no `SessionManager` (no reader thread, no
/// channel, no batching): the ceiling the PTY itself gives on this machine. It tells a slow PTY
/// from a slow pump.
fn run_raw(path: &std::path::Path) -> Rep {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let spec = print_spec(path);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open the pty");
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");
    let master = Arc::new(Mutex::new(Some(pair.master)));
    let started = Instant::now();
    let waiter_master = Arc::clone(&master);
    let waiter = std::thread::spawn(move || {
        let _ = child.wait();
        // Closing the PTY is what ends the read on Windows, as in `SessionManager`.
        waiter_master.lock().unwrap().take();
    });
    let mut buf = vec![0u8; 64 * 1024];
    let mut bytes = 0usize;
    let mut reads = 0usize;
    let mut first = None;
    let mut answered = false;
    loop {
        match std::io::Read::read(&mut reader, &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                first.get_or_insert(Instant::now());
                if !answered && buf[..n].windows(4).any(|w| w == b"[6n") {
                    // ConPTY holds the child until this query is answered.
                    let _ = writer.write_all(b"[1;1R").and_then(|()| writer.flush());
                    answered = true;
                }
                bytes += n;
                reads += 1;
            }
        }
        assert!(
            started.elapsed() < REP_TIMEOUT,
            "the raw read did not end in {REP_TIMEOUT:?}"
        );
    }
    let _ = waiter.join();
    let seconds = started.elapsed().as_secs_f64();
    Rep {
        seconds,
        mb_per_s: bytes as f64 / (1024.0 * 1024.0) / seconds,
        bytes,
        batches: reads,
        first_ms: first.map_or(0.0, |t| (t - started).as_secs_f64() * 1000.0),
        longest_gap_ms: 0.0,
    }
}

#[test]
#[ignore = "measurement: run with --ignored (see docs/PERF.md)"]
fn raw_pty_throughput_of_a_large_file() {
    let mb = env_usize("NOREN_PERF_MB", DEFAULT_MB);
    let reps = env_usize("NOREN_PERF_REPS", DEFAULT_REPS);
    let file = BigFile::create(mb * 1024 * 1024, line_width());
    let mut rates = Vec::new();
    for i in 1..=reps {
        let rep = run_raw(&file.path);
        println!(
            "PERF raw rep={i} file_mb={mb} seconds={:.3} mb_per_s={:.2} bytes={} reads={} first_output_ms={:.0}",
            rep.seconds, rep.mb_per_s, rep.bytes, rep.batches, rep.first_ms
        );
        rates.push(rep.mb_per_s);
    }
    rates.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "PERF raw summary file_mb={mb} reps={reps} mb_per_s_median={:.2} min={:.2} max={:.2}",
        median(&rates),
        rates[0],
        rates[rates.len() - 1]
    );
}

#[test]
#[ignore = "measurement: run with --ignored (see docs/PERF.md)"]
fn real_pty_throughput_of_a_large_file() {
    let mb = env_usize("NOREN_PERF_MB", DEFAULT_MB);
    let reps = env_usize("NOREN_PERF_REPS", DEFAULT_REPS);
    let file = BigFile::create(mb * 1024 * 1024, line_width());

    let mut runs = Vec::new();
    for i in 1..=reps {
        let rep = run_once(&file.path);
        println!(
            "PERF pty rep={i} file_mb={mb} seconds={:.3} mb_per_s={:.2} bytes={} batches={} first_output_ms={:.0} longest_gap_ms={:.0}",
            rep.seconds, rep.mb_per_s, rep.bytes, rep.batches, rep.first_ms, rep.longest_gap_ms
        );
        // The terminal may wrap and decorate the text, but it must hand over at least the file.
        assert!(
            rep.bytes >= mb * 1024 * 1024 / 2,
            "only {} bytes arrived for a file of {mb} MB",
            rep.bytes
        );
        runs.push(rep);
    }

    let mut rates: Vec<f64> = runs.iter().map(|r| r.mb_per_s).collect();
    rates.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut gaps: Vec<f64> = runs.iter().map(|r| r.longest_gap_ms).collect();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "PERF pty summary file_mb={mb} reps={reps} mb_per_s_median={:.2} min={:.2} max={:.2} longest_gap_ms_median={:.0}",
        median(&rates),
        rates[0],
        rates[rates.len() - 1],
        median(&gaps)
    );
}
