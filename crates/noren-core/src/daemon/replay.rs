//! Showing the output of a session again after the connection came back (finding 197).
//!
//! When a [`ReconnectingClient`](super::ReconnectingClient) attaches a session again, the daemon
//! answers with everything it kept of the output (up to 1 MiB), which includes what the client had
//! already received and shown before the connection broke. Appending that to the terminal would
//! show the old output a second time. The terminal has two honest ways out, and this module picks
//! between them with the one fact it can have: the last bytes it was given.
//!
//! - **Continue.** The latest bytes shown ([`DeliveredTail`]) are found in the replay, so the
//!   replay is the same stream seen from further back: only what comes after them is new, and that
//!   is all that is sent. The terminal is not touched, so what it holds (the screen of a program,
//!   the scrollback) stays, and what was printed while the connection was down arrives after it.
//! - **Replace.** They are not found: the connection was down so long that more than the daemon's
//!   buffer was printed, or the buffer is smaller than the tail. Nothing can say where the replay
//!   continues, so the terminal is reset ([`RESET_TERMINAL`]) and the whole replay is shown. What
//!   was older than the buffer is gone from the screen (it is gone from the daemon too).
//!
//! Continuing can show a stretch twice, never lose one: when the tail also occurs earlier in the
//! replay (a program that repaints an identical screen), the first occurrence is taken, so the
//! bytes sent start no later than where the new output starts. A short tail (under
//! [`MIN_ANCHOR_BYTES`]) is only believed when the replay starts with it, which is what happens when
//! the tail is everything the session ever printed; anywhere else it could be a coincidence, and a
//! coincidence would drop real output, so the terminal is replaced instead. (A short tail can still
//! match by chance at the very start of a replay that is a buffer's worth of later output: it costs
//! those few bytes of the beginning of that replay, whose older output is already gone.)

/// How many of the latest bytes shown are kept to find where a replay continues: long enough that
/// the same bytes occurring by chance in the replay is not a real worry, short enough to keep for
/// every session.
pub const TAIL_BYTES: usize = 4096;

/// A tail shorter than this is believed only at the very start of the replay (see [`plan_replay`]).
pub const MIN_ANCHOR_BYTES: usize = 256;

/// What a terminal is sent before a replay that replaces everything: `ESC c`, the full reset (it
/// clears the screen and the scrollback and puts every mode back to its default, so a replay that
/// begins in the middle of a sequence starts from a known state).
pub const RESET_TERMINAL: &[u8] = b"\x1bc";

/// The latest [`TAIL_BYTES`] of the output shown so far.
#[derive(Debug, Default, Clone)]
pub struct DeliveredTail {
    /// Up to twice [`TAIL_BYTES`], so the front is dropped once in a while and not at every push.
    bytes: Vec<u8>,
}

impl DeliveredTail {
    pub fn new() -> Self {
        Self::default()
    }

    /// Notes that `data` was shown, after everything before it.
    pub fn push(&mut self, data: &[u8]) {
        self.bytes.extend_from_slice(data);
        if self.bytes.len() > 2 * TAIL_BYTES {
            let excess = self.bytes.len() - TAIL_BYTES;
            self.bytes.drain(..excess);
        }
    }

    /// Forgets everything: the terminal was reset, what it shows is what comes next.
    pub fn clear(&mut self) {
        self.bytes.clear();
    }

    /// The latest bytes shown, at most [`TAIL_BYTES`] of them, oldest first.
    pub fn as_slice(&self) -> &[u8] {
        let start = self.bytes.len().saturating_sub(TAIL_BYTES);
        &self.bytes[start..]
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// What to show of a replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayPlan<'a> {
    /// Show only these bytes, after what is already shown (possibly none).
    Continue(&'a [u8]),
    /// Reset the terminal ([`RESET_TERMINAL`]), then show these bytes.
    Replace(&'a [u8]),
}

/// Decides what to show of `replay` given the latest bytes already shown (`delivered`, at most
/// [`TAIL_BYTES`], see [`DeliveredTail::as_slice`]).
///
/// - Nothing was shown yet: all of the replay is new.
/// - The replay is empty: there is nothing to show.
/// - `delivered` occurs in the replay: what follows its first occurrence is new. A tail shorter than
///   [`MIN_ANCHOR_BYTES`] counts only when the replay starts with it.
/// - It does not: [`ReplayPlan::Replace`].
pub fn plan_replay<'a>(delivered: &[u8], replay: &'a [u8]) -> ReplayPlan<'a> {
    if replay.is_empty() {
        return ReplayPlan::Continue(replay);
    }
    if delivered.is_empty() {
        return ReplayPlan::Continue(replay);
    }
    match find(replay, delivered) {
        Some(at) if at == 0 || delivered.len() >= MIN_ANCHOR_BYTES => {
            ReplayPlan::Continue(&replay[at + delivered.len()..])
        }
        _ => ReplayPlan::Replace(replay),
    }
}

/// The first place `needle` occurs in `haystack` (Knuth-Morris-Pratt: linear in both, whatever the
/// bytes, since a replay is up to 1 MiB and the needle up to [`TAIL_BYTES`]).
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    // failure[i]: the length of the longest proper prefix of needle[..=i] that is also its suffix.
    let mut failure = vec![0usize; needle.len()];
    let mut matched = 0;
    for i in 1..needle.len() {
        while matched > 0 && needle[i] != needle[matched] {
            matched = failure[matched - 1];
        }
        if needle[i] == needle[matched] {
            matched += 1;
        }
        failure[i] = matched;
    }
    matched = 0;
    for (i, byte) in haystack.iter().enumerate() {
        while matched > 0 && *byte != needle[matched] {
            matched = failure[matched - 1];
        }
        if *byte == needle[matched] {
            matched += 1;
            if matched == needle.len() {
                return Some(i + 1 - needle.len());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_occurrence_of_a_needle_is_found_in_linear_time_whatever_the_bytes() {
        assert_eq!(find(b"abcabd", b"abd"), Some(3));
        assert_eq!(find(b"abc", b""), Some(0));
        assert_eq!(find(b"abc", b"abcd"), None);
        assert_eq!(find(b"", b"a"), None);
        assert_eq!(find(b"aaaaab", b"aab"), Some(3));
        assert_eq!(find(b"abababac", b"abac"), Some(4));
        assert_eq!(find(b"xxabxx", b"ab"), Some(2));
        // The worst case for a naive search: a long run of one byte and a needle that ends differently.
        let haystack = vec![b'a'; 1024 * 1024];
        let mut needle = vec![b'a'; TAIL_BYTES - 1];
        needle.push(b'b');
        assert_eq!(find(&haystack, &needle), None);
        let mut with_end = haystack.clone();
        with_end.push(b'b');
        assert_eq!(find(&with_end, &needle), Some(with_end.len() - TAIL_BYTES));
    }

    #[test]
    fn find_agrees_with_a_naive_search_on_small_alphabets() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..4000 {
            let haystack: Vec<u8> = (0..(next() % 40))
                .map(|_| b'a' + (next() % 3) as u8)
                .collect();
            let needle: Vec<u8> = (0..(next() % 6))
                .map(|_| b'a' + (next() % 3) as u8)
                .collect();
            let naive = if needle.is_empty() {
                Some(0)
            } else {
                haystack
                    .windows(needle.len())
                    .position(|window| window == needle.as_slice())
            };
            assert_eq!(find(&haystack, &needle), naive, "{haystack:?} {needle:?}");
        }
    }

    #[test]
    fn nothing_shown_yet_means_all_of_the_replay_is_new() {
        assert_eq!(
            plan_replay(b"", b"prompt$ "),
            ReplayPlan::Continue(b"prompt$ ")
        );
    }

    #[test]
    fn an_empty_replay_has_nothing_to_show_whatever_was_shown() {
        assert_eq!(plan_replay(b"abc", b""), ReplayPlan::Continue(b""));
        assert_eq!(plan_replay(b"", b""), ReplayPlan::Continue(b""));
    }

    /// `count` numbered lines starting at `from`: output that does not repeat.
    fn lines(from: usize, count: usize) -> Vec<u8> {
        (from..from + count)
            .flat_map(|n| format!("line {n:06}\r\n").into_bytes())
            .collect()
    }

    #[test]
    fn what_was_shown_is_not_shown_again_and_what_came_after_it_is() {
        // The session printed 3000 lines; the link broke after 2500; 500 more were printed.
        let stream = lines(0, 3000);
        let shown = &stream[..lines(0, 2500).len()];
        let mut tail = DeliveredTail::new();
        tail.push(shown);
        assert_eq!(tail.as_slice().len(), TAIL_BYTES);
        // The daemon kept it all: the replay is the whole stream, and only the new part is sent.
        assert_eq!(
            plan_replay(tail.as_slice(), &stream),
            ReplayPlan::Continue(&lines(2500, 500)[..])
        );
        // It kept only the last 1000 lines, which still reach back past the tail.
        let kept = &stream[lines(0, 2000).len()..];
        assert_eq!(
            plan_replay(tail.as_slice(), kept),
            ReplayPlan::Continue(&lines(2500, 500)[..])
        );
        // Nothing was printed meanwhile: nothing to add.
        assert_eq!(
            plan_replay(tail.as_slice(), shown),
            ReplayPlan::Continue(b"")
        );
    }

    #[test]
    fn everything_the_session_ever_printed_is_found_at_the_start_however_short() {
        // A shell that printed its prompt and one answer: the tail is all of it, the replay starts
        // with it, and what came after is new.
        let replay = b"prompt$ ls\r\na  b\r\nprompt$ ";
        assert_eq!(
            plan_replay(b"prompt$ ls\r\n", replay),
            ReplayPlan::Continue(b"a  b\r\nprompt$ ")
        );
        assert_eq!(plan_replay(replay, replay), ReplayPlan::Continue(b""));
    }

    #[test]
    fn a_short_tail_found_anywhere_else_may_be_a_coincidence_so_the_screen_is_replaced() {
        // The tail "prompt$ " is in the replay, but not at its start: it could be any prompt of
        // many, and believing it would drop what was printed in between.
        let replay = b"one\r\nprompt$ two\r\nprompt$ ";
        assert_eq!(
            plan_replay(b"prompt$ ", replay),
            ReplayPlan::Replace(replay)
        );
    }

    #[test]
    fn a_tail_the_replay_does_not_hold_replaces_the_screen() {
        // More was printed than the daemon keeps: the replay does not reach back to the tail.
        let stream = lines(0, 3000);
        let mut tail = DeliveredTail::new();
        tail.push(&stream[..lines(0, 1000).len()]);
        let kept = &stream[lines(0, 2000).len()..];
        assert_eq!(
            plan_replay(tail.as_slice(), kept),
            ReplayPlan::Replace(kept)
        );
        // The tail is longer than the whole replay (a small buffer in the daemon).
        assert_eq!(
            plan_replay(&lines(0, 100), b"tail"),
            ReplayPlan::Replace(b"tail")
        );
        // The replay begins inside the tail: it reaches back only part of the way, which is not
        // enough to say where it goes on.
        let tail_end = lines(0, 1000).len();
        let cut_inside = &stream[tail_end - 100..];
        assert_eq!(
            plan_replay(tail.as_slice(), cut_inside),
            ReplayPlan::Replace(cut_inside)
        );
    }

    #[test]
    fn bytes_that_repeat_may_be_shown_twice_but_the_new_output_is_never_lost() {
        // A program that paints the same 300-byte screen again and again, then prints something new.
        let frame: Vec<u8> = (0..300).map(|i| b'a' + (i % 26) as u8).collect();
        let mut stream = frame.repeat(30);
        let shown = stream.len();
        stream.extend_from_slice(b"NEW OUTPUT\r\n");
        let mut tail = DeliveredTail::new();
        tail.push(&stream[..shown]);
        let ReplayPlan::Continue(sent) = plan_replay(tail.as_slice(), &stream) else {
            panic!("the tail is in the replay");
        };
        assert!(sent.ends_with(b"NEW OUTPUT\r\n"));
        // The first occurrence of the tail is earlier than the true one, so some frames come twice.
        assert!(sent.len() > b"NEW OUTPUT\r\n".len());
        assert!(stream.ends_with(sent));
    }

    #[test]
    fn continuing_never_loses_what_was_printed_while_the_link_was_down() {
        // A stream of a few letters (so stretches repeat), a link that breaks at `shown`, a daemon
        // that kept the last `kept` bytes of the `total` printed by the time it came back.
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..3000 {
            let total = 1 + (next() % 1200) as usize;
            let stream: Vec<u8> = (0..total).map(|_| b'a' + (next() % 3) as u8).collect();
            let shown = (next() % (total as u64 + 1)) as usize;
            let kept = 1 + (next() % total as u64) as usize;
            let replay = &stream[total - kept..];
            let mut tail = DeliveredTail::new();
            tail.push(&stream[..shown]);
            let new = &stream[shown..];
            // Whether the tail lies inside what the daemon kept. If it does, the replay holds the
            // true place where the output goes on, and nothing printed since may be lost. If it
            // does not (the daemon kept less than was printed), a short tail can still match by
            // chance at the very start of the replay, which costs at most that many bytes of it.
            let tail_is_kept = shown - shown.min(TAIL_BYTES) >= total - kept;
            match plan_replay(tail.as_slice(), replay) {
                ReplayPlan::Continue(sent) => {
                    assert!(
                        replay.ends_with(sent),
                        "round {round}: what is sent is the end of the replay"
                    );
                    if tail_is_kept {
                        assert!(
                            sent.ends_with(new),
                            "round {round}: the output printed while down is not lost \
                             (shown {shown} of {total}, kept {kept})"
                        );
                    }
                }
                ReplayPlan::Replace(all) => {
                    assert_eq!(all, replay, "round {round}");
                    assert!(
                        shown > 0,
                        "round {round}: with nothing shown the replay is simply continued"
                    );
                }
            }
        }
    }

    #[test]
    fn the_tail_keeps_the_latest_bytes_only_and_forgets_on_clear() {
        let mut tail = DeliveredTail::new();
        assert!(tail.is_empty());
        tail.push(b"abc");
        tail.push(b"def");
        assert_eq!(tail.as_slice(), b"abcdef");
        // Far more than it keeps, in pieces of any size.
        let long: Vec<u8> = (0..(5 * TAIL_BYTES + 7)).map(|i| (i % 251) as u8).collect();
        for piece in long.chunks(1000) {
            tail.push(piece);
        }
        assert_eq!(tail.as_slice(), &long[long.len() - TAIL_BYTES..]);
        // One push larger than it keeps.
        let mut one = DeliveredTail::new();
        one.push(&long);
        assert_eq!(one.as_slice(), &long[long.len() - TAIL_BYTES..]);
        tail.clear();
        assert!(tail.is_empty());
        assert_eq!(tail.as_slice(), b"");
    }

    #[test]
    fn a_full_reset_is_escape_c() {
        assert_eq!(RESET_TERMINAL, &[0x1b, b'c']);
    }
}
