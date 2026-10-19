//! Where the output of one live session goes.
//!
//! The output of a session leaves through a `tauri::ipc::Channel`, and a channel belongs to the page
//! that made it. A shell opened in the quick window and promoted to the main window has to change
//! page without changing process, so the threads of the session do not hold the channel: they hold
//! an [`OutputRoute`], and the channel sits behind it. [`OutputRoute::replace`] puts another one
//! there. Sending and replacing take the same lock, so each chunk of output goes to exactly one
//! channel: the old one for everything sent before the replacement, the new one for everything after.

use std::sync::{Mutex, MutexGuard};

use tauri::ipc::{Channel, InvokeResponseBody};

struct Inner {
    channel: Channel<InvokeResponseBody>,
    /// How many channels the route has had (the first one counts).
    channels: u32,
    /// Chunks handed to the current channel without an error.
    delivered: u64,
    /// The last bytes handed to the current channel, when asked for (see [`OutputRoute::record_tail`]).
    tail: Option<Tail>,
}

struct Tail {
    limit: usize,
    bytes: Vec<u8>,
}

/// The destination of the output of a session, which can be changed while the session runs.
pub struct OutputRoute {
    inner: Mutex<Inner>,
}

impl OutputRoute {
    pub fn new(channel: Channel<InvokeResponseBody>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                channel,
                channels: 1,
                delivered: 0,
                tail: None,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sends a chunk of output to the current channel. A failed send means the page is gone; the
    /// session ends with the app, so the chunk is dropped.
    pub fn send(&self, bytes: &[u8]) {
        let mut inner = self.lock();
        if inner
            .channel
            .send(InvokeResponseBody::Raw(bytes.to_vec()))
            .is_err()
        {
            return;
        }
        inner.delivered += 1;
        if let Some(tail) = &mut inner.tail {
            tail.bytes.extend_from_slice(bytes);
            let excess = tail.bytes.len().saturating_sub(tail.limit);
            tail.bytes.drain(..excess);
        }
    }

    /// Makes `channel` the destination of everything sent from now on. Returns the channel it
    /// replaces, which gets nothing more.
    pub fn replace(&self, channel: Channel<InvokeResponseBody>) -> Channel<InvokeResponseBody> {
        let mut inner = self.lock();
        let old = std::mem::replace(&mut inner.channel, channel);
        inner.channels += 1;
        inner.delivered = 0;
        if let Some(tail) = &mut inner.tail {
            tail.bytes.clear();
        }
        old
    }

    /// How many channels the route has had; a session that never changed page has had one.
    pub fn channels(&self) -> u32 {
        self.lock().channels
    }

    /// How many chunks the current channel received.
    pub fn delivered(&self) -> u64 {
        self.lock().delivered
    }

    /// Starts keeping the last `limit` bytes the current channel received, for [`Self::tail`]. The
    /// smoke run reads what reached the new page this way; a normal session keeps nothing.
    pub fn record_tail(&self, limit: usize) {
        self.lock().tail = Some(Tail {
            limit,
            bytes: Vec::new(),
        });
    }

    /// The last bytes the current channel received (empty unless [`Self::record_tail`] was called).
    pub fn tail(&self) -> Vec<u8> {
        self.lock()
            .tail
            .as_ref()
            .map_or_else(Vec::new, |tail| tail.bytes.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::mpsc::{self, Receiver};

    /// A channel whose chunks come out of the receiver.
    fn listening() -> (Channel<InvokeResponseBody>, Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = tx.send(bytes);
            }
            Ok(())
        });
        (channel, rx)
    }

    fn chunks(rx: &Receiver<Vec<u8>>) -> Vec<Vec<u8>> {
        rx.try_iter().collect()
    }

    #[test]
    fn output_before_the_replacement_goes_to_the_old_channel_and_after_it_only_to_the_new_one() {
        let (old, old_rx) = listening();
        let (new, new_rx) = listening();
        let route = OutputRoute::new(old);
        route.send(b"one");
        route.send(b"two");
        drop(route.replace(new));
        route.send(b"three");

        assert_eq!(chunks(&old_rx), vec![b"one".to_vec(), b"two".to_vec()]);
        assert_eq!(chunks(&new_rx), vec![b"three".to_vec()]);
        assert_eq!(route.channels(), 2);
    }

    #[test]
    fn the_counts_are_per_channel() {
        let (old, _old_rx) = listening();
        let (new, _new_rx) = listening();
        let route = OutputRoute::new(old);
        assert_eq!((route.channels(), route.delivered()), (1, 0));
        route.send(b"a");
        route.send(b"b");
        assert_eq!(route.delivered(), 2);
        drop(route.replace(new));
        assert_eq!((route.channels(), route.delivered()), (2, 0));
        route.send(b"c");
        assert_eq!(route.delivered(), 1);
    }

    #[test]
    fn a_channel_that_refuses_the_output_is_not_counted() {
        let failing = Channel::new(|_body: InvokeResponseBody| Err(tauri::Error::WindowNotFound));
        let route = OutputRoute::new(failing);
        route.send(b"lost");
        assert_eq!(route.delivered(), 0);
    }

    #[test]
    fn the_tail_keeps_the_last_bytes_of_the_current_channel_only() {
        let (old, _old_rx) = listening();
        let (new, _new_rx) = listening();
        let route = OutputRoute::new(old);
        assert!(route.tail().is_empty(), "nothing is kept unless asked");
        route.record_tail(5);
        route.send(b"abc");
        route.send(b"defgh");
        assert_eq!(route.tail(), b"defgh");
        drop(route.replace(new));
        assert!(route.tail().is_empty(), "the old channel's bytes are gone");
        route.send(b"xy");
        assert_eq!(route.tail(), b"xy");
    }

    #[test]
    fn replacing_while_output_flows_loses_and_repeats_nothing() {
        const CHUNKS: u32 = 2000;
        let (old, old_rx) = listening();
        let (new, new_rx) = listening();
        let route = Arc::new(OutputRoute::new(old));

        let sender = {
            let route = Arc::clone(&route);
            std::thread::spawn(move || {
                for n in 0..CHUNKS {
                    route.send(&n.to_be_bytes());
                }
            })
        };
        // Swap somewhere in the middle of the flow.
        while route.delivered() < u64::from(CHUNKS / 2) {
            std::thread::yield_now();
        }
        drop(route.replace(new));
        sender.join().expect("the sender thread");

        let number = |chunk: &Vec<u8>| u32::from_be_bytes(chunk.as_slice().try_into().unwrap());
        let before: Vec<u32> = chunks(&old_rx).iter().map(number).collect();
        let after: Vec<u32> = chunks(&new_rx).iter().map(number).collect();
        // Wherever the swap fell, the old channel got a prefix and the new one the rest, in order,
        // with no gap and no repeat.
        let joined: Vec<u32> = before.iter().chain(after.iter()).copied().collect();
        assert_eq!(joined, (0..CHUNKS).collect::<Vec<_>>());
    }
}
