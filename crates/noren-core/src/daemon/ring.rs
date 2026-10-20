//! The buffer a session keeps of its latest output: a ring of bytes with a fixed ceiling, so a
//! client that attaches later is given what the terminal showed while nobody watched.

use std::collections::VecDeque;

/// The latest bytes written to it, at most `capacity` of them. Older bytes are dropped as new
/// ones arrive.
#[derive(Debug)]
pub struct ByteRing {
    bytes: VecDeque<u8>,
    capacity: usize,
    /// How many bytes were pushed out so far.
    dropped: u64,
}

impl ByteRing {
    /// A ring that keeps up to `capacity` bytes (zero keeps nothing).
    pub fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            capacity,
            dropped: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Bytes held now.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Bytes pushed out because the ring was full.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Appends `data`, dropping the oldest bytes when the ring would pass its capacity.
    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.capacity {
            // Everything held goes, and so does the front of `data` that does not fit.
            self.dropped += (self.bytes.len() + data.len() - self.capacity) as u64;
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - self.capacity..]);
            return;
        }
        let overflow = (self.bytes.len() + data.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.dropped += overflow as u64;
        }
        self.bytes.extend(data);
    }

    /// A copy of what is held, oldest byte first. When the ring has dropped bytes the copy may
    /// begin in the middle of a character: the bytes of a UTF-8 sequence that lost its start are
    /// left out. (It may still begin in the middle of an escape sequence; the ring keeps bytes,
    /// not the state of a terminal.)
    pub fn snapshot(&self) -> Vec<u8> {
        let (front, back) = self.bytes.as_slices();
        let mut copy = Vec::with_capacity(self.bytes.len());
        copy.extend_from_slice(front);
        copy.extend_from_slice(back);
        if self.dropped > 0 {
            // A character has at most three continuation bytes after its first byte.
            let skip = copy
                .iter()
                .take(3)
                .take_while(|byte| (**byte & 0xC0) == 0x80)
                .count();
            copy.drain(..skip);
        }
        copy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_keeps_everything_below_the_capacity() {
        let mut ring = ByteRing::new(10);
        ring.push(b"abc");
        ring.push(b"def");
        assert_eq!(ring.snapshot(), b"abcdef");
        assert_eq!(ring.len(), 6);
        assert_eq!(ring.dropped(), 0);
        assert!(!ring.is_empty());
    }

    #[test]
    fn it_drops_the_oldest_bytes_first() {
        let mut ring = ByteRing::new(5);
        ring.push(b"abc");
        ring.push(b"def");
        assert_eq!(ring.snapshot(), b"bcdef");
        assert_eq!(ring.dropped(), 1);
        ring.push(b"gh");
        assert_eq!(ring.snapshot(), b"defgh");
        assert_eq!(ring.dropped(), 3);
    }

    #[test]
    fn exactly_the_capacity_fits_and_one_more_does_not() {
        let mut ring = ByteRing::new(4);
        ring.push(b"abcd");
        assert_eq!(ring.snapshot(), b"abcd");
        assert_eq!(ring.dropped(), 0);
        ring.push(b"e");
        assert_eq!(ring.snapshot(), b"bcde");
        assert_eq!(ring.dropped(), 1);
    }

    #[test]
    fn a_push_bigger_than_the_ring_keeps_only_its_tail() {
        let mut ring = ByteRing::new(4);
        ring.push(b"ab");
        ring.push(b"0123456789");
        assert_eq!(ring.snapshot(), b"6789");
        assert_eq!(ring.len(), 4);
        // "ab" and "012345" were pushed out.
        assert_eq!(ring.dropped(), 8);
    }

    #[test]
    fn a_ring_of_zero_keeps_nothing_and_counts_what_it_dropped() {
        let mut ring = ByteRing::new(0);
        ring.push(b"abc");
        assert!(ring.is_empty());
        assert_eq!(ring.snapshot(), b"");
        assert_eq!(ring.dropped(), 3);
        ring.push(b"");
        assert_eq!(ring.dropped(), 3);
    }

    #[test]
    fn it_survives_many_wraps_in_odd_sizes() {
        let mut ring = ByteRing::new(7);
        let mut all = Vec::new();
        for round in 0..200u32 {
            let chunk: Vec<u8> = (0..(round % 5 + 1)).map(|i| b'a' + (i as u8)).collect();
            ring.push(&chunk);
            all.extend_from_slice(&chunk);
            let start = all.len().saturating_sub(7);
            assert_eq!(ring.snapshot(), all[start..], "round {round}");
        }
        assert_eq!(ring.dropped(), (all.len() - 7) as u64);
    }

    #[test]
    fn the_snapshot_does_not_start_in_the_middle_of_a_character() {
        let mut ring = ByteRing::new(5);
        // "é" is two bytes (c3 a9). Pushing past the capacity cuts the first one.
        ring.push("aéé".as_bytes()); // 5 bytes: 61 c3 a9 c3 a9, fits
        assert_eq!(ring.snapshot(), "aéé".as_bytes());
        ring.push(b"b"); // drops 61, keeps c3 a9 c3 a9 62
        assert_eq!(
            ring.snapshot(),
            "éé"
                .as_bytes()
                .iter()
                .chain(b"b")
                .copied()
                .collect::<Vec<_>>()
        );
        ring.push(b"c"); // drops c3, keeps a9 c3 a9 62 63: starts on a continuation byte
        let copy = ring.snapshot();
        assert_eq!(
            copy,
            "é".as_bytes()
                .iter()
                .chain(b"bc")
                .copied()
                .collect::<Vec<_>>()
        );
        assert!(std::str::from_utf8(&copy).is_ok());
    }

    #[test]
    fn nothing_is_skipped_while_nothing_was_dropped() {
        let mut ring = ByteRing::new(10);
        // A buffer that begins with a continuation byte on its own is kept as it came.
        ring.push(&[0x80, b'a']);
        assert_eq!(ring.snapshot(), [0x80, b'a']);
    }
}
