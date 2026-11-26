//! PostgreSQL wire framing: reading whole messages, writing the few the
//! gateway authors itself.
//!
//! Every message after startup is a type byte, a 4-byte big-endian length
//! that counts itself, and a body. The gateway reads each one whole (bounded
//! by [`MAX_MESSAGE_BYTES`]) before judging or relaying it, so a message is
//! never half forwarded, and keeps its bytes as they arrived so relaying one
//! copies nothing it does not have to. Startup-phase messages have no type
//! byte; they are read by [`read_startup`].

use bytes::{Buf, BufMut, Bytes, BytesMut};
use dbproxy::limits::MAX_MESSAGE_BYTES;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The largest startup-phase packet accepted: the startup parameters are a
/// handful of short strings, so anything near this is not a real client.
const MAX_STARTUP_BYTES: usize = 10_000;

/// How much a [`FrameReader`] asks the socket for at a time.
const READ_CHUNK: usize = 64 * 1024;

/// One framed message, as it travels: tag, length, body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    raw: Bytes,
}

impl Frame {
    /// A message the gateway authors.
    pub fn new(tag: u8, body: &[u8]) -> Self {
        let mut raw = BytesMut::with_capacity(5 + body.len());
        raw.put_u8(tag);
        // Authored bodies are tiny, and relayed ones were bounded on read.
        raw.put_u32(u32::try_from(body.len() + 4).unwrap_or(u32::MAX));
        raw.put_slice(body);
        Self { raw: raw.freeze() }
    }

    pub fn tag(&self) -> u8 {
        self.raw[0]
    }

    /// The body, after the tag and length.
    pub fn body(&self) -> Bytes {
        self.raw.slice(5..)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.raw
    }
}

/// Reads whole frames from a stream it owns, and lends the stream out for
/// writing. Reading is cancel-safe: a partial frame stays buffered, so the
/// session can wait on both of its sides at once.
pub struct FrameReader<S> {
    stream: S,
    buf: BytesMut,
}

impl<S: AsyncRead + AsyncWrite + Unpin> FrameReader<S> {
    pub fn new(stream: S) -> Self {
        Self {
            stream,
            buf: BytesMut::with_capacity(READ_CHUNK),
        }
    }

    /// The stream, for writing.
    pub fn stream(&mut self) -> &mut S {
        &mut self.stream
    }

    /// The next frame; `None` at a clean end of stream.
    pub async fn next(&mut self) -> std::io::Result<Option<Frame>> {
        loop {
            if let Some(frame) = self.buffered()? {
                return Ok(Some(frame));
            }
            if self.stream.read_buf(&mut self.buf).await? == 0 {
                return if self.buf.is_empty() {
                    Ok(None)
                } else {
                    Err(std::io::ErrorKind::UnexpectedEof.into())
                };
            }
        }
    }

    /// Whether a whole frame is already buffered, so [`Self::next`] would
    /// not wait on the stream.
    pub fn has_frame(&self) -> bool {
        self.buf.len() >= 5 && {
            let len = u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]);
            self.buf.len() > len as usize
        }
    }

    /// A frame already read in whole, without touching the stream.
    pub fn buffered(&mut self) -> std::io::Result<Option<Frame>> {
        if self.buf.len() < 5 {
            self.buf.reserve(READ_CHUNK);
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
        let body_len = len
            .checked_sub(4)
            .ok_or_else(|| invalid("message length shorter than its own header"))?;
        if body_len > MAX_MESSAGE_BYTES {
            return Err(invalid("message larger than the gateway relays (16 MiB)"));
        }
        let total = 5 + body_len;
        if self.buf.len() < total {
            self.buf.reserve(total - self.buf.len());
            return Ok(None);
        }
        Ok(Some(Frame {
            raw: self.buf.split_to(total).freeze(),
        }))
    }
}

/// Read one startup-phase packet (no type byte): its body after the length.
pub async fn read_startup<R: AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Bytes> {
    let len = reader.read_u32().await? as usize;
    let body_len = len
        .checked_sub(4)
        .ok_or_else(|| invalid("startup length shorter than its own header"))?;
    if !(4..=MAX_STARTUP_BYTES).contains(&body_len) {
        return Err(invalid("startup packet of an impossible size"));
    }
    let mut body = BytesMut::zeroed(body_len);
    reader.read_exact(&mut body).await?;
    Ok(body.freeze())
}

/// Write `frames` in one buffered write.
pub async fn write_frames<'a, W: AsyncWrite + Unpin>(
    writer: &mut W,
    frames: impl IntoIterator<Item = &'a Frame>,
) -> std::io::Result<()> {
    let mut out = BytesMut::new();
    for frame in frames {
        out.extend_from_slice(frame.as_bytes());
    }
    writer.write_all(&out).await?;
    writer.flush().await
}

pub(crate) fn invalid(message: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

// ── Message bodies the gateway reads ─────────────────────────────────────

/// A cursor over a message body, for the handful of fields the gateway
/// reads. Every accessor fails on a short or malformed body instead of
/// panicking: the bytes come from the network.
pub struct Reader {
    buf: Bytes,
}

impl Reader {
    pub fn new(buf: Bytes) -> Self {
        Self { buf }
    }

    /// A NUL-terminated string, as UTF-8.
    pub fn cstr(&mut self) -> std::io::Result<String> {
        String::from_utf8(self.name()?).map_err(|_| invalid("string in message is not UTF-8"))
    }

    /// A NUL-terminated string as raw bytes: a statement or portal name,
    /// which the server keys by its bytes whatever their encoding.
    pub fn name(&mut self) -> std::io::Result<Vec<u8>> {
        let end = self
            .buf
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| invalid("unterminated string in message"))?;
        let name = self.buf[..end].to_vec();
        self.buf.advance(end + 1);
        Ok(name)
    }

    pub fn u8(&mut self) -> std::io::Result<u8> {
        self.need(1)?;
        Ok(self.buf.get_u8())
    }

    pub fn i32(&mut self) -> std::io::Result<i32> {
        self.need(4)?;
        Ok(self.buf.get_i32())
    }

    /// The next `len` bytes.
    pub fn bytes(&mut self, len: usize) -> std::io::Result<Bytes> {
        self.need(len)?;
        Ok(self.buf.split_to(len))
    }

    /// Everything not read yet.
    pub fn rest(self) -> Bytes {
        self.buf
    }

    fn need(&self, len: usize) -> std::io::Result<()> {
        if self.buf.len() < len {
            Err(invalid("message shorter than its fields"))
        } else {
            Ok(())
        }
    }
}

/// One field of an `ErrorResponse` or `NoticeResponse` body (`b'C'` the
/// SQLSTATE, `b'M'` the message).
pub fn diagnostic_field(body: &[u8], code: u8) -> Option<String> {
    let mut rest = body;
    while let Some((&field, tail)) = rest.split_first() {
        if field == 0 {
            return None;
        }
        let end = tail.iter().position(|&b| b == 0)?;
        if field == code {
            return Some(String::from_utf8_lossy(&tail[..end]).into_owned());
        }
        rest = &tail[end + 1..];
    }
    None
}

// ── Messages the gateway writes ───────────────────────────────────────────────

/// Transaction status, as `ReadyForQuery` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxStatus {
    Idle,
    InTransaction,
    Failed,
}

impl TxStatus {
    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            b'I' => Some(Self::Idle),
            b'T' => Some(Self::InTransaction),
            b'E' => Some(Self::Failed),
            _ => None,
        }
    }

    fn byte(self) -> u8 {
        match self {
            Self::Idle => b'I',
            Self::InTransaction => b'T',
            Self::Failed => b'E',
        }
    }
}

/// `ReadyForQuery` with `status`.
pub fn ready_for_query(status: TxStatus) -> Frame {
    Frame::new(b'Z', &[status.byte()])
}

/// An `ErrorResponse`.
pub fn error_response(severity: &str, sqlstate: &str, message: &str, hint: Option<&str>) -> Frame {
    diagnostic(b'E', severity, sqlstate, message, hint)
}

/// A `NoticeResponse`: shown by psql and logged by drivers, never an error.
pub fn notice_response(sqlstate: &str, message: &str, hint: Option<&str>) -> Frame {
    diagnostic(b'N', "WARNING", sqlstate, message, hint)
}

fn diagnostic(tag: u8, severity: &str, sqlstate: &str, message: &str, hint: Option<&str>) -> Frame {
    let mut body = BytesMut::new();
    let mut field = |code: u8, value: &str| {
        body.put_u8(code);
        // A NUL inside a value would end the field early on the client.
        body.put_slice(value.replace('\0', " ").as_bytes());
        body.put_u8(0);
    };
    field(b'S', severity);
    field(b'V', severity);
    field(b'C', sqlstate);
    field(b'M', message);
    if let Some(hint) = hint {
        field(b'H', hint);
    }
    body.put_u8(0);
    Frame::new(tag, &body)
}

/// `AuthenticationCleartextPassword`: the gateway asks for the agent's token
/// (only ever over TLS).
pub fn auth_cleartext_request() -> Frame {
    Frame::new(b'R', &3i32.to_be_bytes())
}

/// `AuthenticationOk`.
pub fn auth_ok() -> Frame {
    Frame::new(b'R', &0i32.to_be_bytes())
}

/// `BackendKeyData` with the gateway's own cancel key for this session.
pub fn backend_key_data(process_id: i32, secret: &[u8]) -> Frame {
    let mut body = BytesMut::with_capacity(4 + secret.len());
    body.put_i32(process_id);
    body.put_slice(secret);
    Frame::new(b'K', &body)
}

/// `NegotiateProtocolVersion`: the newest minor version the gateway speaks
/// (3.0) and the protocol options it did not recognize.
pub fn negotiate_protocol_version(unrecognized: &[String]) -> Frame {
    let mut body = BytesMut::new();
    body.put_i32(0);
    body.put_i32(i32::try_from(unrecognized.len()).unwrap_or(i32::MAX));
    for option in unrecognized {
        body.put_slice(option.as_bytes());
        body.put_u8(0);
    }
    Frame::new(b'v', &body)
}

/// A simple `Query`.
pub fn query(text: &str) -> Frame {
    let mut body = BytesMut::with_capacity(text.len() + 1);
    body.put_slice(text.as_bytes());
    body.put_u8(0);
    Frame::new(b'Q', &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_and_split_across_reads() {
        let first = query("SELECT 1");
        let second = Frame::new(b'S', &[]);
        let mut wire = first.as_bytes().to_vec();
        wire.extend_from_slice(second.as_bytes());
        // Deliver the bytes one at a time: frames still come out whole.
        let (mut client, server) = tokio::io::duplex(1);
        let writer = tokio::spawn(async move {
            for byte in wire {
                client.write_all(&[byte]).await.unwrap();
            }
        });
        let mut reader = FrameReader::new(server);
        assert_eq!(reader.next().await.unwrap(), Some(first));
        assert_eq!(reader.next().await.unwrap(), Some(second));
        writer.await.unwrap();
        assert_eq!(reader.next().await.unwrap(), None, "clean end");
    }

    #[tokio::test]
    async fn malformed_lengths_are_refused_not_trusted() {
        let (mut client, server) = tokio::io::duplex(64);
        client.write_all(&[b'Q', 0, 0, 0, 2]).await.unwrap();
        assert!(FrameReader::new(server).next().await.is_err());
        let (mut client, server) = tokio::io::duplex(64);
        let huge = (MAX_MESSAGE_BYTES as u32 + 5).to_be_bytes();
        client
            .write_all(&[b'Q', huge[0], huge[1], huge[2], huge[3]])
            .await
            .unwrap();
        assert!(FrameReader::new(server).next().await.is_err());
        let mut tiny_startup: &[u8] = &[0, 0, 0, 6, 0, 0];
        assert!(read_startup(&mut tiny_startup).await.is_err());
    }

    #[tokio::test]
    async fn a_stream_cut_mid_frame_is_an_error() {
        let (mut client, server) = tokio::io::duplex(64);
        client.write_all(&[b'Q', 0, 0, 0, 9, b'S']).await.unwrap();
        drop(client);
        assert!(FrameReader::new(server).next().await.is_err());
    }

    #[test]
    fn diagnostics_strip_nul_and_read_back_by_field() {
        let frame = error_response("ERROR", "42501", "no\0pe", Some("ask"));
        assert_eq!(frame.tag(), b'E');
        let body = frame.body();
        assert_eq!(diagnostic_field(&body, b'C').as_deref(), Some("42501"));
        assert_eq!(diagnostic_field(&body, b'M').as_deref(), Some("no pe"));
        assert_eq!(diagnostic_field(&body, b'H').as_deref(), Some("ask"));
        assert_eq!(diagnostic_field(&body, b'D'), None);
        assert_eq!(diagnostic_field(b"Mx", b'M'), None, "unterminated");
    }

    #[test]
    fn readers_fail_on_short_bodies() {
        let mut reader = Reader::new(Bytes::from_static(b"abc"));
        assert!(reader.cstr().is_err(), "no terminator");
        let mut reader = Reader::new(Bytes::from_static(&[0, 1]));
        assert!(reader.i32().is_err());
        let mut reader = Reader::new(Bytes::from_static(&[0xff, 0]));
        assert!(reader.cstr().is_err(), "not UTF-8");
    }
}
