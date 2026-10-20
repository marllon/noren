//! Frames on an async stream: the I/O half of [`protocol`](super::protocol), which only knows
//! bytes. Works on any `AsyncRead` / `AsyncWrite`, so the same code serves a named pipe, a Unix
//! socket and the in-memory streams of the tests.

use std::fmt;
use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::protocol::{FRAME_HEADER_BYTES, ProtocolError, parse_frame_len};

/// Why a frame could not be read.
#[derive(Debug)]
pub enum FrameError {
    /// The other side closed the stream between two frames: the normal end of a conversation.
    Closed,
    /// The bytes are not a frame: a length of zero, a length over the limit, a stream that ends
    /// in the middle of a frame.
    Protocol(ProtocolError),
    /// The stream failed.
    Io(io::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => write!(f, "the connection was closed"),
            Self::Protocol(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "i/o error: {e}"),
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Closed => None,
            Self::Protocol(e) => Some(e),
            Self::Io(e) => Some(e),
        }
    }
}

impl From<ProtocolError> for FrameError {
    fn from(e: ProtocolError) -> Self {
        Self::Protocol(e)
    }
}

/// Reads one frame and returns its payload. The length is checked against the limit before the
/// payload is read, and the payload is read into a buffer that grows with the bytes that really
/// arrive, so a peer that announces a big frame and sends nothing costs nothing.
///
/// Not cancel safe: a caller that stops waiting must drop the stream.
pub async fn read_frame<R>(reader: &mut R) -> Result<Vec<u8>, FrameError>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0u8; FRAME_HEADER_BYTES];
    let mut have = 0;
    while have < header.len() {
        match reader.read(&mut header[have..]).await {
            Ok(0) => {
                return Err(if have == 0 {
                    FrameError::Closed
                } else {
                    ProtocolError::Truncated.into()
                });
            }
            Ok(n) => have += n,
            // The other end went away between two frames; Windows reports it this way.
            Err(e)
                if have == 0
                    && matches!(
                        e.kind(),
                        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                    ) =>
            {
                return Err(FrameError::Closed);
            }
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    let len = parse_frame_len(header)?;
    let mut payload = Vec::new();
    let read = (&mut *reader)
        .take(len as u64)
        .read_to_end(&mut payload)
        .await
        .map_err(FrameError::Io)?;
    if read < len {
        return Err(ProtocolError::Truncated.into());
    }
    Ok(payload)
}

/// Writes a whole frame (as built by `to_frame`) and flushes it.
pub async fn write_frame<W>(writer: &mut W, frame: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    writer.write_all(frame).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::daemon::protocol::{ClientMessage, MAX_FRAME_BYTES, PROTOCOL_VERSION};

    fn hello_frame() -> Vec<u8> {
        ClientMessage::Hello {
            version: PROTOCOL_VERSION,
        }
        .to_frame()
        .unwrap()
    }

    fn is_protocol(result: Result<Vec<u8>, FrameError>, expected: &ProtocolError) -> bool {
        matches!(result, Err(FrameError::Protocol(e)) if &e == expected)
    }

    #[tokio::test]
    async fn frames_come_out_one_by_one_and_the_end_is_a_clean_close() {
        let mut bytes = hello_frame();
        bytes.extend(hello_frame());
        let mut reader = &bytes[..];
        let first = read_frame(&mut reader).await.unwrap();
        let second = read_frame(&mut reader).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(
            ClientMessage::decode(&first).unwrap(),
            ClientMessage::Hello {
                version: PROTOCOL_VERSION
            }
        );
        assert!(matches!(
            read_frame(&mut reader).await,
            Err(FrameError::Closed)
        ));
    }

    #[tokio::test]
    async fn a_stream_that_ends_inside_a_frame_is_truncated() {
        let frame = hello_frame();
        // Cut inside the length prefix, right after it, and inside the payload.
        for cut in [1, 2, 3, 4, frame.len() - 1] {
            let mut reader = &frame[..cut];
            assert!(
                is_protocol(read_frame(&mut reader).await, &ProtocolError::Truncated),
                "cut at {cut}"
            );
        }
    }

    #[tokio::test]
    async fn a_length_over_the_limit_is_refused_before_the_payload_is_read() {
        let announced = u32::try_from(MAX_FRAME_BYTES).unwrap() + 1;
        let mut bytes = announced.to_be_bytes().to_vec();
        bytes.extend_from_slice(&[0u8; 64]);
        let mut reader = &bytes[..];
        assert!(is_protocol(
            read_frame(&mut reader).await,
            &ProtocolError::FrameTooLarge {
                len: MAX_FRAME_BYTES + 1,
                max: MAX_FRAME_BYTES
            }
        ));
        assert_eq!(reader.len(), 64, "only the length prefix was consumed");
    }

    #[tokio::test]
    async fn a_length_of_zero_is_refused() {
        let bytes = 0u32.to_be_bytes();
        let mut reader = &bytes[..];
        assert!(is_protocol(
            read_frame(&mut reader).await,
            &ProtocolError::EmptyFrame
        ));
    }

    #[tokio::test]
    async fn a_big_length_with_no_bytes_behind_it_is_truncated_and_not_allocated() {
        let bytes = u32::try_from(MAX_FRAME_BYTES).unwrap().to_be_bytes();
        let mut reader = &bytes[..];
        assert!(is_protocol(
            read_frame(&mut reader).await,
            &ProtocolError::Truncated
        ));
    }

    #[tokio::test]
    async fn a_frame_that_arrives_a_byte_at_a_time_is_put_together() {
        let frame = hello_frame();
        // A pipe that holds one byte forces the reader to see the frame in pieces.
        let (mut near, mut far) = tokio::io::duplex(1);
        let sent = frame.clone();
        let writer = tokio::spawn(async move {
            write_frame(&mut far, &sent).await.unwrap();
        });
        let payload = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut near))
            .await
            .expect("no hang")
            .unwrap();
        writer.await.unwrap();
        assert_eq!(payload, frame[FRAME_HEADER_BYTES..]);
    }
}
