//! The agent's side of a session's start: TLS, the startup packet, and the
//! OneCLI token.
//!
//! A client opens with one of:
//!
//! - `SSLRequest`, answered `S`, then a TLS handshake (every libpq release);
//! - a TLS `ClientHello` straight away with ALPN `postgresql`
//!   (`sslnegotiation=direct`, libpq 17+);
//! - `GSSENCRequest`, answered `N` so the client falls back to TLS;
//! - a `CancelRequest`, handled by [`crate::cancel`] and closed;
//! - a plain `StartupMessage`, which is refused: the agent's token must
//!   never cross the network in the clear.
//!
//! Inside TLS the startup packet names the connection (`user`) and database;
//! the gateway asks for a password and takes the agent's OneCLI token from
//! it. Only a short allowlist of startup parameters reaches the server.

use anyhow::{bail, Result};
use bytes::Bytes;
use ca::{AppProtocol, CertificateAuthority};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

use crate::cancel::{CancelKeys, CANCEL_REQUEST_CODE};
use crate::settings;
use crate::wire::{self, FrameReader, Reader};

/// `SSLRequest`.
const SSL_REQUEST_CODE: i32 = 80_877_103;
/// `GSSENCRequest`.
const GSSENC_REQUEST_CODE: i32 = 80_877_104;
/// Protocol 3.x, the major version every supported client speaks.
const PROTOCOL_MAJOR_3: i32 = 3 << 16;

/// The first byte of a TLS record carrying a handshake.
pub const TLS_HANDSHAKE: u8 = 0x16;

/// The name the gateway's certificate carries for the database front door.
/// Agents verify it against the OneCLI CA (`sslmode=verify-ca`) or check
/// only the chain; the name is fixed so it never depends on how the gateway
/// is addressed.
const CERTIFICATE_NAME: &str = "postgres.gateway.onecli";

/// Startup parameters passed through to the server. Anything else is
/// dropped: `options` could set any server setting at login (`-c role=...`),
/// `replication` opens a replication session, and the gateway pins
/// `client_encoding` and sets `application_name` itself. A passed value must
/// still keep the setting guards ([`settings::check_startup_parameter`]).
const PASSED_PARAMETERS: &[&str] = &[
    "DateStyle",
    "IntervalStyle",
    "TimeZone",
    "extra_float_digits",
    "datestyle",
    "intervalstyle",
    "lc_messages",
    "search_path",
    "timezone",
];

/// The TLS stream from the agent.
pub type ClientStream = TlsStream<TcpStream>;

/// A client that finished its startup packet, inside TLS.
pub struct Started {
    pub conn: FrameReader<ClientStream>,
    /// The connection id the agent named as its user.
    pub connection_id: String,
    /// The database it asked for (empty when it named none).
    pub database: String,
    /// Allowlisted parameters to pass to the server.
    pub parameters: Vec<(String, String)>,
    /// Why a passed parameter is refused, when one is: the session is then
    /// answered with it once the agent is known.
    pub refused_parameter: Option<&'static str>,
    /// Protocol options (`_pq_.*`) the client asked for, which the gateway
    /// declines through `NegotiateProtocolVersion`.
    pub unrecognized_options: Vec<String>,
    /// Whether the client asked for protocol 3.1 or later; it is offered 3.0.
    pub wants_newer_minor: bool,
}

/// What the first packets turned out to be.
pub enum Opening {
    /// A session to log in.
    Session(Box<Started>),
    /// A cancel request, already handled; close the connection.
    Cancelled,
}

/// Why a start was refused, before there is a protocol to answer in.
#[derive(Debug)]
pub enum StartError {
    /// The client sent a startup packet without TLS. Answered with an error
    /// the client shows, then closed.
    Plaintext,
    /// Anything else malformed or unsupported.
    Malformed(String),
}

/// Read the client's opening: TLS (either way in), then its startup packet.
pub async fn accept(
    mut tcp: TcpStream,
    ca: &CertificateAuthority,
    cancels: &CancelKeys,
) -> Result<Opening, StartError> {
    let acceptor = || {
        ca.server_config_for(CERTIFICATE_NAME, AppProtocol::Postgres)
            .map(TlsAcceptor::from)
            .map_err(|e| StartError::Malformed(e.to_string()))
    };
    let mut first = [0u8; 1];
    let peeked = tcp
        .peek(&mut first)
        .await
        .map_err(|e| StartError::Malformed(e.to_string()))?;
    if peeked == 0 {
        return Err(StartError::Malformed("closed before speaking".into()));
    }
    let tls = if first[0] == TLS_HANDSHAKE {
        // Direct TLS: the acceptor's ALPN refuses a client that offers
        // another protocol, and a client that offers none is accepted (the
        // first byte already said it is not HTTP's plaintext).
        acceptor()?
            .accept(tcp)
            .await
            .map_err(|e| StartError::Malformed(format!("TLS handshake failed: {e}")))?
    } else {
        loop {
            let packet = read_startup(&mut tcp).await?;
            match packet.code {
                SSL_REQUEST_CODE => {
                    write(&mut tcp, b"S").await?;
                    break acceptor()?.accept(tcp).await.map_err(|e| {
                        StartError::Malformed(format!("TLS handshake failed: {e}"))
                    })?;
                }
                GSSENC_REQUEST_CODE => write(&mut tcp, b"N").await?,
                CANCEL_REQUEST_CODE => {
                    cancels.cancel(&packet.rest).await;
                    return Ok(Opening::Cancelled);
                }
                code if code >> 16 == 3 => {
                    refuse_plaintext(&mut tcp).await;
                    return Err(StartError::Plaintext);
                }
                code => {
                    return Err(StartError::Malformed(format!(
                        "unknown startup code {code}"
                    )))
                }
            }
        }
    };
    startup_inside_tls(tls)
        .await
        .map(|started| Opening::Session(Box::new(started)))
}

/// The startup packet, read inside TLS. A client may still send a cancel
/// request over TLS; nothing else but a 3.x startup is accepted.
async fn startup_inside_tls(mut tls: ClientStream) -> Result<Started, StartError> {
    let packet = read_startup(&mut tls).await?;
    if packet.code >> 16 != 3 {
        return Err(StartError::Malformed(format!(
            "unsupported protocol version {}.{}",
            packet.code >> 16,
            packet.code & 0xffff
        )));
    }
    let mut reader = Reader::new(packet.rest);
    let mut connection_id = None;
    let mut database = String::new();
    let mut parameters = Vec::new();
    let mut refused_parameter = None;
    let mut unrecognized_options = Vec::new();
    loop {
        let name = reader
            .cstr()
            .map_err(|e| StartError::Malformed(e.to_string()))?;
        if name.is_empty() {
            break;
        }
        let value = reader
            .cstr()
            .map_err(|e| StartError::Malformed(e.to_string()))?;
        match name.as_str() {
            "user" => connection_id = Some(value),
            "database" => database = value,
            _ if name.starts_with("_pq_.") => unrecognized_options.push(name),
            _ if PASSED_PARAMETERS.contains(&name.as_str()) => {
                refused_parameter =
                    refused_parameter.or(settings::check_startup_parameter(&name, &value));
                parameters.push((name, value));
            }
            _ => {}
        }
    }
    let connection_id = connection_id
        .filter(|id| !id.is_empty())
        .ok_or_else(|| StartError::Malformed("the startup packet names no user".into()))?;
    Ok(Started {
        conn: FrameReader::new(tls),
        connection_id,
        database,
        parameters,
        refused_parameter,
        unrecognized_options,
        wants_newer_minor: packet.code != PROTOCOL_MAJOR_3,
    })
}

/// Ask for the password and return it: the agent's OneCLI token.
pub async fn read_token(conn: &mut FrameReader<ClientStream>) -> Result<String> {
    wire::write_frames(conn.stream(), [&wire::auth_cleartext_request()]).await?;
    let Some(frame) = conn.next().await? else {
        bail!("the client closed the connection before sending its token");
    };
    if frame.tag() != b'p' {
        bail!("the client answered the password request with another message");
    }
    let token = Reader::new(frame.body()).cstr()?;
    Ok(token)
}

struct StartupPacket {
    code: i32,
    rest: Bytes,
}

async fn read_startup<S: AsyncRead + Unpin>(stream: &mut S) -> Result<StartupPacket, StartError> {
    let body = wire::read_startup(stream)
        .await
        .map_err(|e| StartError::Malformed(e.to_string()))?;
    let code = i32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    Ok(StartupPacket {
        code,
        rest: body.slice(4..),
    })
}

async fn write<S: AsyncWrite + Unpin>(stream: &mut S, bytes: &[u8]) -> Result<(), StartError> {
    stream
        .write_all(bytes)
        .await
        .map_err(|e| StartError::Malformed(e.to_string()))
}

/// Tell a plaintext client why it was refused, in a message psql shows.
async fn refuse_plaintext<S: AsyncWrite + Unpin>(stream: &mut S) {
    let frame = wire::error_response(
        "FATAL",
        "28000",
        "the OneCLI gateway accepts database sessions over TLS only",
        Some("connect with sslmode=require (or verify-ca with the OneCLI CA certificate)"),
    );
    let _ = wire::write_frames(stream, [&frame]).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn startup(parameters: &[(&str, &str)], version: i32) -> Vec<u8> {
        let mut body = version.to_be_bytes().to_vec();
        for (name, value) in parameters {
            body.extend_from_slice(name.as_bytes());
            body.push(0);
            body.extend_from_slice(value.as_bytes());
            body.push(0);
        }
        body.push(0);
        let mut packet = u32::try_from(body.len() + 4)
            .unwrap()
            .to_be_bytes()
            .to_vec();
        packet.extend_from_slice(&body);
        packet
    }

    #[tokio::test]
    async fn startup_packets_are_read_and_filtered() {
        let packet = startup(
            &[
                ("user", "conn_1"),
                ("database", "app"),
                ("options", "-c role=admin"),
                ("replication", "database"),
                ("application_name", "psql"),
                ("TimeZone", "UTC"),
                ("_pq_.command_marker", "1"),
            ],
            PROTOCOL_MAJOR_3 | 2,
        );
        let mut stream = &packet[..];
        let read = read_startup(&mut stream).await.unwrap();
        assert_eq!(read.code, PROTOCOL_MAJOR_3 | 2);
        // The parameter loop, without a TLS stream around it.
        let mut reader = Reader::new(read.rest);
        let mut kept = Vec::new();
        loop {
            let name = reader.cstr().unwrap();
            if name.is_empty() {
                break;
            }
            let value = reader.cstr().unwrap();
            if PASSED_PARAMETERS.contains(&name.as_str()) {
                kept.push((name, value));
            }
        }
        assert_eq!(kept, vec![("TimeZone".to_string(), "UTC".to_string())]);
    }

    #[tokio::test]
    async fn malformed_startup_packets_are_errors() {
        let mut short: &[u8] = &[0, 0, 0, 3];
        assert!(read_startup(&mut short).await.is_err());
        let mut huge: &[u8] = &[0, 1, 0, 0];
        assert!(read_startup(&mut huge).await.is_err());
    }
}
