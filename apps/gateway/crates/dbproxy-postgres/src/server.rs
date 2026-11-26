//! The gateway's own login to the database server: TLS first (unless the
//! connection turned it off), then the startup message, then whichever
//! password exchange the server asks for.
//!
//! With TLS (`verify-full` or `require`, which only decide how much of the
//! certificate is checked), the gateway offers `SSLRequest` and refuses a
//! server that declines it ([`UpstreamError::NoTls`]). Then:
//!
//! - **SCRAM-SHA-256**, with channel binding (`SCRAM-SHA-256-PLUS`,
//!   `tls-server-end-point`) whenever the server offers it, which ties the
//!   exchange to this TLS session so a man in the middle cannot relay it;
//! - **MD5**, for older servers;
//! - **cleartext**, which is safe here only because the session is TLS.
//!
//! Without TLS (`disable`, the user's explicit choice for a server with SSL
//! off), only a completed SCRAM-SHA-256 exchange is accepted: the password
//! itself is never sent and the server must prove it knows it. MD5,
//! cleartext and `trust` are refused ([`UpstreamError::WeakLoginWithoutTls`]).
//! That is all plaintext can protect. The session itself is readable and
//! alterable on the network path, and an observer of the exchange can still
//! guess a weak password offline (RFC 5802, section 9).
//!
//! The server's `ParameterStatus` and `BackendKeyData` messages are collected
//! for the session; the agent is told the gateway's own cancel key, never
//! the server's.

use anyhow::{anyhow, bail, Result};
use bytes::BytesMut;
use dbproxy::target::DbTarget;
use dbproxy::upstream;
use postgres_protocol::authentication::md5_hash;
use postgres_protocol::authentication::sasl::{ChannelBinding, ScramSha256, SCRAM_SHA_256};
use postgres_protocol::message::frontend;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use crate::wire::{self, Frame, FrameReader, Reader, TxStatus};

/// The `SCRAM-SHA-256-PLUS` mechanism name.
const SCRAM_SHA_256_PLUS: &str = "SCRAM-SHA-256-PLUS";

/// The connection to the database server: TLS, unless the connection was
/// stored with TLS explicitly off (see [`TlsMode::Disable`]).
pub enum ServerStream {
    Tls(Box<TlsStream<TcpStream>>),
    Plain(TcpStream),
}

impl ServerStream {
    /// Whether this stream is encrypted.
    #[must_use]
    pub fn encrypted(&self) -> bool {
        matches!(self, Self::Tls(_))
    }
}

impl AsyncRead for ServerStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
            Self::Plain(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for ServerStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
            Self::Plain(s) => Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
            Self::Plain(s) => Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
            Self::Plain(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// A server session the gateway has logged in to, ready for queries.
pub struct ServerSession {
    pub conn: FrameReader<ServerStream>,
    /// Every `ParameterStatus` the server sent, in order, to replay to the
    /// agent as its own login completes.
    pub parameters: Vec<Frame>,
    /// The server's cancel key, which only the gateway ever holds.
    pub cancel_key: CancelKey,
}

/// A backend's process id and secret, as `BackendKeyData` carries them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelKey {
    pub process_id: i32,
    pub secret: Vec<u8>,
}

/// Why the gateway could not log in. Upstream diagnostics can echo stored
/// credentials, so both Display and Debug expose only gateway-owned text.
pub enum UpstreamError {
    /// Reaching the server failed (refused destination, no answer).
    Dial(upstream::DialError),
    /// The server answered the gateway's SSL request with "no": its
    /// `ssl` setting is off, or a pooler in front of it does not speak TLS.
    /// Distinct from `Tls` because the fix is on the server, not in OneCLI.
    NoTls,
    /// The connection has TLS off, and the server asked for an MD5 or
    /// cleartext password (which an observer could crack or read), or for no
    /// password at all. Only SCRAM-SHA-256 is allowed without TLS.
    WeakLoginWithoutTls,
    /// The TLS handshake itself failed. Carries the TLS library's reason,
    /// which the gateway generates and never contains a credential.
    Tls(String),
    /// The server rejected the stored credentials or database; carries the
    /// server's own message.
    Rejected(String),
    /// The server asked for something the gateway does not do (Kerberos,
    /// GSSAPI, SSPI) or spoke out of turn.
    Unsupported(String),
}

impl std::fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Dial(error) => error.fmt(f),
            Self::NoTls => write!(
                f,
                "the database server does not accept SSL; turn on `ssl` in its postgresql.conf, or set the connection's TLS to No encryption in the OneCLI dashboard"
            ),
            Self::WeakLoginWithoutTls => write!(
                f,
                "the database server did not ask for a SCRAM-SHA-256 password over a connection without SSL; OneCLI allows only that login there"
            ),
            Self::Tls(_) => write!(
                f,
                "the gateway could not open TLS to the database server; check the connection's TLS setting"
            ),
            Self::Rejected(_) => write!(
                f,
                "the database server refused the stored login; update the connection in the OneCLI dashboard"
            ),
            Self::Unsupported(_) => write!(
                f,
                "the database server could not complete a supported password login; check its authentication settings"
            ),
        }
    }
}

impl std::fmt::Debug for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for UpstreamError {}

fn tls_error(error: impl std::fmt::Display) -> UpstreamError {
    UpstreamError::Tls(error.to_string())
}

/// The login stopped partway (a dropped socket, a malformed message), with
/// or without TLS.
fn broke_off(error: impl std::fmt::Display) -> UpstreamError {
    UpstreamError::Unsupported(format!("broke off the login ({error})"))
}

/// Ask for TLS on a fresh socket and complete the handshake.
async fn open_tls(mut tcp: TcpStream, target: &DbTarget) -> Result<ServerStream, UpstreamError> {
    let mut request = BytesMut::new();
    frontend::ssl_request(&mut request);
    tcp.write_all(&request).await.map_err(tls_error)?;
    // `S` or `N` (protocol 54.2.10). Anything else (an old server's
    // ErrorResponse, a service that is not PostgreSQL) is not "SSL is off",
    // and its text is never shown: the server is not authenticated yet.
    match tcp.read_u8().await.map_err(tls_error)? {
        b'S' => {}
        b'N' => return Err(UpstreamError::NoTls),
        _ => return Err(tls_error("the server did not answer the SSL request")),
    }
    // No ALPN on the SSLRequest path: servers before 17 may reject it.
    let config = upstream::client_config(target, &[]).map_err(tls_error)?;
    let name = upstream::server_name(target).map_err(tls_error)?;
    let stream = TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|error| {
            // The handshake reason (certificate not trusted, no common
            // version) is the TLS library's own text, never a credential:
            // log it so a failing connection can be diagnosed.
            tracing::warn!(reason = %error, host = %target.host, "database TLS handshake failed");
            tls_error(error)
        })?;
    Ok(ServerStream::Tls(Box::new(stream)))
}

/// Dial `target`, open TLS (unless the connection turned it off), and log in
/// with its stored credentials. `parameters` are the startup parameters
/// beyond `user` and `database`.
pub async fn connect(
    target: &DbTarget,
    parameters: &[(&str, &str)],
) -> Result<ServerSession, UpstreamError> {
    let tcp = upstream::dial(target).await.map_err(UpstreamError::Dial)?;
    let mut stream = if target.tls.encrypts() {
        open_tls(tcp, target).await?
    } else {
        // The user chose no TLS for a server with SSL off. Nothing is
        // negotiated: the startup message goes straight on the socket, and
        // `authenticate` refuses any login but SCRAM-SHA-256.
        ServerStream::Plain(tcp)
    };

    let mut startup = BytesMut::new();
    let mut all = vec![
        ("user", target.username.as_str()),
        ("database", target.database.as_str()),
    ];
    all.extend_from_slice(parameters);
    frontend::startup_message(all, &mut startup).map_err(broke_off)?;
    stream.write_all(&startup).await.map_err(broke_off)?;
    stream.flush().await.map_err(broke_off)?;

    let mut conn = FrameReader::new(stream);
    authenticate(&mut conn, target).await.map_err(|error| {
        match error.downcast::<UpstreamError>() {
            Ok(upstream) => upstream,
            Err(other) => broke_off(other),
        }
    })?;
    finish_startup(conn).await
}

/// Run the password exchange the server asks for, until `AuthenticationOk`.
async fn authenticate(conn: &mut FrameReader<ServerStream>, target: &DbTarget) -> Result<()> {
    let mut scram: Option<ScramSha256> = None;
    let mut scram_finished = false;
    loop {
        let frame = read(conn).await?;
        match frame.tag() {
            b'R' => {}
            b'E' => return Err(UpstreamError::Rejected(server_message(&frame)).into()),
            other => bail!("unexpected message {:?} during login", char::from(other)),
        }
        let mut body = Reader::new(frame.body());
        let mut reply = BytesMut::new();
        let code = body.i32()?;
        // Without TLS, never send the password or an MD5 hash an observer
        // could replay: only SCRAM keeps both out of the exchange.
        if !conn.stream().encrypted() && matches!(code, 3 | 5) {
            return Err(UpstreamError::WeakLoginWithoutTls.into());
        }
        match code {
            // Without TLS, a server that let us in with no SCRAM exchange
            // (`trust`) proved nothing about itself: refuse it, so "no SSL"
            // always means a SCRAM login both sides proved.
            0 if !conn.stream().encrypted() && !scram_finished => {
                return Err(UpstreamError::WeakLoginWithoutTls.into())
            }
            0 => return Ok(()),
            3 => frontend::password_message(target.password.as_bytes(), &mut reply)?,
            5 => {
                let salt: [u8; 4] = body.bytes(4)?.as_ref().try_into()?;
                let hashed = md5_hash(target.username.as_bytes(), target.password.as_bytes(), salt);
                frontend::password_message(hashed.as_bytes(), &mut reply)?;
            }
            10 => {
                let mechanisms = sasl_mechanisms(body)?;
                let offers = |name: &str| mechanisms.iter().any(|m| m == name);
                let encrypted = conn.stream().encrypted();
                let (mechanism, binding) = if offers(SCRAM_SHA_256_PLUS) && encrypted {
                    let end_point = end_point(conn.stream())?;
                    (
                        SCRAM_SHA_256_PLUS,
                        ChannelBinding::tls_server_end_point(end_point),
                    )
                } else if offers(SCRAM_SHA_256) {
                    // GS2 flag (RFC 5802): `y` over TLS lets a server that
                    // offered binding detect a stripped `-PLUS`; without TLS
                    // there is nothing to bind, so `n`, as libpq sends.
                    let binding = if encrypted {
                        ChannelBinding::unrequested()
                    } else {
                        ChannelBinding::unsupported()
                    };
                    (SCRAM_SHA_256, binding)
                } else {
                    return Err(UpstreamError::Unsupported(format!(
                        "offers only SASL mechanisms the gateway does not support ({})",
                        mechanisms.join(", ")
                    ))
                    .into());
                };
                let exchange = ScramSha256::new(target.password.as_bytes(), binding);
                frontend::sasl_initial_response(mechanism, exchange.message(), &mut reply)?;
                scram = Some(exchange);
            }
            11 => {
                let exchange = scram
                    .as_mut()
                    .ok_or_else(|| anyhow!("SASL continue before start"))?;
                exchange.update(&body.rest())?;
                frontend::sasl_response(exchange.message(), &mut reply)?;
            }
            12 => {
                // The server's proof: a server that does not know the
                // password cannot produce it.
                let mut exchange = scram
                    .take()
                    .ok_or_else(|| anyhow!("SASL final before start"))?;
                exchange.finish(&body.rest())?;
                scram_finished = true;
                continue;
            }
            other => {
                return Err(UpstreamError::Unsupported(format!(
                "asks for an authentication method the gateway does not support (code {other}); \
                     use a password (SCRAM-SHA-256 or MD5) login"
            ))
                .into())
            }
        }
        conn.stream().write_all(&reply).await?;
        conn.stream().flush().await?;
    }
}

/// Read parameters and the cancel key until the first `ReadyForQuery`.
async fn finish_startup(
    mut conn: FrameReader<ServerStream>,
) -> Result<ServerSession, UpstreamError> {
    let mut parameters = Vec::new();
    let mut cancel_key = None;
    loop {
        let frame = read(&mut conn)
            .await
            .map_err(|e| UpstreamError::Unsupported(format!("broke off the login ({e})")))?;
        match frame.tag() {
            b'S' => parameters.push(frame),
            b'K' => {
                let mut body = Reader::new(frame.body());
                let process_id = body
                    .i32()
                    .map_err(|e| UpstreamError::Unsupported(e.to_string()))?;
                cancel_key = Some(CancelKey {
                    process_id,
                    secret: body.rest().to_vec(),
                });
            }
            b'Z' => {
                let cancel_key = cancel_key
                    .ok_or_else(|| UpstreamError::Unsupported("sent no cancel key".into()))?;
                return Ok(ServerSession {
                    conn,
                    parameters,
                    cancel_key,
                });
            }
            b'E' => return Err(UpstreamError::Rejected(server_message(&frame))),
            b'N' => {}
            other => {
                return Err(UpstreamError::Unsupported(format!(
                    "sent an unexpected message {:?} during login",
                    char::from(other)
                )))
            }
        }
    }
}

/// What the logged-in role may do beyond the statement checks, read once per
/// session. A superuser, or a member of the roles that grant the server's own
/// files and programs (`pg_read_server_files`, `pg_write_server_files`,
/// `pg_execute_server_program`), can reach the operating system by routes no
/// statement check can enumerate, which the dashboard warns about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RolePowers {
    /// A superuser, or a role with a superuser's reach to the server's own
    /// files and programs.
    pub superuser: bool,
}

/// Ask the server whether the session's role holds superuser-equivalent
/// powers. Runs a fixed catalog query on the gateway's own connection,
/// before the agent's first message. `pg_has_role` follows inherited
/// membership, the way the privilege checks themselves do.
pub async fn role_powers(conn: &mut FrameReader<ServerStream>) -> Result<RolePowers> {
    wire::write_frames(
        conn.stream(),
        [&wire::query(
            "SELECT r.rolsuper \
                OR pg_catalog.pg_has_role(r.oid, 'pg_read_server_files', 'USAGE') \
                OR pg_catalog.pg_has_role(r.oid, 'pg_write_server_files', 'USAGE') \
                OR pg_catalog.pg_has_role(r.oid, 'pg_execute_server_program', 'USAGE') \
             FROM pg_catalog.pg_roles r WHERE r.rolname = current_user",
        )],
    )
    .await?;
    let mut superuser = false;
    loop {
        let frame = read(conn).await?;
        match frame.tag() {
            b'D' => {
                // One column: its length, then `t` or `f`.
                let body = frame.body();
                superuser = body.get(6) == Some(&b't');
            }
            b'Z' => {
                let status = frame.body().first().copied().and_then(TxStatus::from_byte);
                anyhow::ensure!(
                    status == Some(TxStatus::Idle),
                    "role check left a transaction open"
                );
                return Ok(RolePowers { superuser });
            }
            b'E' => bail!("the database server refused the role check"),
            _ => {}
        }
    }
}

async fn read(conn: &mut FrameReader<ServerStream>) -> Result<Frame> {
    conn.next()
        .await?
        .ok_or_else(|| anyhow!("the server closed the connection"))
}

/// The mechanisms an `AuthenticationSASL` body lists.
fn sasl_mechanisms(mut body: Reader) -> Result<Vec<String>> {
    let mut mechanisms = Vec::new();
    loop {
        let mechanism = body.cstr()?;
        if mechanism.is_empty() {
            return Ok(mechanisms);
        }
        mechanisms.push(mechanism);
    }
}

/// The message of an `ErrorResponse`, or a generic description.
pub fn server_message(frame: &Frame) -> String {
    wire::diagnostic_field(&frame.body(), b'M')
        .unwrap_or_else(|| "the server gave no reason".to_string())
}

/// The `tls-server-end-point` channel binding (RFC 5929): a hash of the
/// server's certificate, with the hash its signature uses (SHA-256 for MD5
/// and SHA-1 signatures).
fn end_point(stream: &ServerStream) -> Result<Vec<u8>> {
    let ServerStream::Tls(stream) = stream else {
        bail!("channel binding needs TLS");
    };
    let certificate = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|chain| chain.first())
        .ok_or_else(|| anyhow!("the server presented no certificate"))?;
    let algorithm = match signature_hash(certificate.as_ref()) {
        Some(SignatureHash::Sha384) => &ring::digest::SHA384,
        Some(SignatureHash::Sha512) => &ring::digest::SHA512,
        Some(SignatureHash::Sha256) | None => &ring::digest::SHA256,
    };
    Ok(ring::digest::digest(algorithm, certificate.as_ref())
        .as_ref()
        .to_vec())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignatureHash {
    Sha256,
    Sha384,
    Sha512,
}

/// The hash in a certificate's `signatureAlgorithm`, read from its DER:
/// `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm SEQUENCE {
/// OID, ... }, signature }`. `None` when the DER is malformed.
fn signature_hash(der: &[u8]) -> Option<SignatureHash> {
    let certificate = der_contents(der, 0x30)?.0;
    let after_tbs = der_skip(certificate)?;
    let algorithm = der_contents(after_tbs, 0x30)?.0;
    let oid = der_contents(algorithm, 0x06)?.0;
    // sha384 / sha512 with RSA end in .12 / .13 under 1.2.840.113549.1.1;
    // with ECDSA in .3 / .4 under 1.2.840.10045.4.3. Everything else
    // (SHA-256 signatures, Ed25519, RSA-PSS) binds with SHA-256.
    const RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01];
    const ECDSA: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03];
    match oid.split_last()? {
        (12, arc) if arc == RSA => Some(SignatureHash::Sha384),
        (13, arc) if arc == RSA => Some(SignatureHash::Sha512),
        (3, arc) if arc == ECDSA => Some(SignatureHash::Sha384),
        (4, arc) if arc == ECDSA => Some(SignatureHash::Sha512),
        _ => Some(SignatureHash::Sha256),
    }
}

/// The contents of the DER element at the start of `der` with tag `tag`,
/// and what follows it.
fn der_contents(der: &[u8], tag: u8) -> Option<(&[u8], &[u8])> {
    let (&found, rest) = der.split_first()?;
    if found != tag {
        return None;
    }
    let (len, rest) = der_length(rest)?;
    (rest.len() >= len).then(|| rest.split_at(len))
}

/// What follows the DER element at the start of `der`, whatever its tag.
fn der_skip(der: &[u8]) -> Option<&[u8]> {
    let (_, rest) = der.split_first()?;
    let (len, rest) = der_length(rest)?;
    rest.get(len..)
}

fn der_length(der: &[u8]) -> Option<(usize, &[u8])> {
    let (&first, rest) = der.split_first()?;
    if first < 0x80 {
        return Some((usize::from(first), rest));
    }
    let count = usize::from(first & 0x7f);
    if count == 0 || count > 4 || rest.len() < count {
        return None;
    }
    let (bytes, rest) = rest.split_at(count);
    let len = bytes
        .iter()
        .fold(0usize, |len, &b| (len << 8) | usize::from(b));
    Some((len, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn certificate_with(alg: &'static rcgen::SignatureAlgorithm) -> Vec<u8> {
        let key = rcgen::KeyPair::generate_for(alg).unwrap();
        rcgen::CertificateParams::new(vec!["db.example.com".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap()
            .der()
            .to_vec()
    }

    #[test]
    fn the_binding_hash_follows_the_certificate_signature() {
        assert_eq!(
            signature_hash(&certificate_with(&rcgen::PKCS_ECDSA_P256_SHA256)),
            Some(SignatureHash::Sha256)
        );
        assert_eq!(
            signature_hash(&certificate_with(&rcgen::PKCS_ECDSA_P384_SHA384)),
            Some(SignatureHash::Sha384)
        );
        assert_eq!(
            signature_hash(&certificate_with(&rcgen::PKCS_ED25519)),
            Some(SignatureHash::Sha256)
        );
        assert_eq!(signature_hash(&[0x30, 0x82, 0xff]), None, "truncated");
        assert_eq!(signature_hash(&[]), None);
    }

    #[test]
    fn login_diagnostics_cannot_echo_stored_credentials() {
        let secret = "upstream-echoed-password-marker";
        for error in [
            UpstreamError::Rejected(secret.into()),
            UpstreamError::Unsupported(secret.into()),
            UpstreamError::Tls(secret.into()),
        ] {
            assert!(!error.to_string().contains(secret));
            assert!(!format!("{error:?}").contains(secret));
        }
    }

    #[test]
    fn error_messages_are_read_from_their_field() {
        let frame = wire::error_response("FATAL", "28P01", "password authentication failed", None);
        assert_eq!(server_message(&frame), "password authentication failed");
        assert_eq!(
            server_message(&Frame::new(b'E', &[0])),
            "the server gave no reason"
        );
    }

    #[test]
    fn sasl_mechanism_lists_end_at_an_empty_name() {
        let body = bytes::Bytes::from_static(b"SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0");
        assert_eq!(
            sasl_mechanisms(Reader::new(body)).unwrap(),
            vec!["SCRAM-SHA-256-PLUS", "SCRAM-SHA-256"]
        );
        assert!(sasl_mechanisms(Reader::new(bytes::Bytes::from_static(b"X"))).is_err());
    }

    /// Bound on a stub exchange, so a regression that sends a password (and
    /// then waits for a reply the stub never gives) fails instead of hanging.
    const STUB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    /// A connected socket pair: the gateway's end and a stub server's end.
    async fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        (client, server)
    }

    fn plain_target() -> DbTarget {
        DbTarget::from_credentials(
            r#"{"host":"db.example.com","port":5432,"database":"d","username":"u","password":"stub-password-marker","sslmode":"disable"}"#,
        )
        .unwrap()
    }

    fn auth_request(code: i32, payload: &[u8]) -> Vec<u8> {
        let mut body = code.to_be_bytes().to_vec();
        body.extend_from_slice(payload);
        Frame::new(b'R', &body).as_bytes().to_vec()
    }

    /// One frontend message: tag, then the body after its length.
    async fn read_message(server: &mut TcpStream) -> (u8, Vec<u8>) {
        let tag = server.read_u8().await.unwrap();
        let len = usize::try_from(server.read_u32().await.unwrap()).unwrap();
        let mut body = vec![0; len - 4];
        server.read_exact(&mut body).await.unwrap();
        (tag, body)
    }

    /// Without TLS, an MD5 or cleartext request, or a `trust` login, is
    /// refused before anything derived from the password is sent.
    #[tokio::test]
    async fn without_tls_weak_logins_are_refused_and_send_nothing() {
        for request in [
            auth_request(3, &[]),
            auth_request(5, &[1, 2, 3, 4]),
            auth_request(0, &[]),
        ] {
            let (client, mut server) = socket_pair().await;
            let mut conn = FrameReader::new(ServerStream::Plain(client));
            server.write_all(&request).await.unwrap();
            let refused =
                tokio::time::timeout(STUB_TIMEOUT, authenticate(&mut conn, &plain_target()))
                    .await
                    .expect("the login answered a weak request instead of refusing it")
                    .unwrap_err();
            assert!(matches!(
                refused.downcast_ref::<UpstreamError>(),
                Some(UpstreamError::WeakLoginWithoutTls)
            ));
            drop(conn);
            let mut sent = Vec::new();
            server.read_to_end(&mut sent).await.unwrap();
            assert!(sent.is_empty(), "code {}: sent {sent:?}", request[8]);
        }
    }

    /// Without TLS, SCRAM is chosen over an offered `-PLUS` with the GS2 `n`
    /// flag (nothing to bind), and a server that skips its SCRAM proof and
    /// answers `AuthenticationOk` is refused.
    #[tokio::test]
    async fn without_tls_scram_is_unbound_and_must_finish() {
        let (client, mut server) = socket_pair().await;
        let mut conn = FrameReader::new(ServerStream::Plain(client));
        server
            .write_all(&auth_request(10, b"SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0"))
            .await
            .unwrap();
        let stub = async {
            let (tag, body) = read_message(&mut server).await;
            server.write_all(&auth_request(0, &[])).await.unwrap();
            (tag, body)
        };
        let target = plain_target();
        let (login, (tag, body)) = tokio::time::timeout(STUB_TIMEOUT, async {
            tokio::join!(authenticate(&mut conn, &target), stub)
        })
        .await
        .expect("the SCRAM exchange stalled");
        assert!(matches!(
            login.unwrap_err().downcast_ref::<UpstreamError>(),
            Some(UpstreamError::WeakLoginWithoutTls)
        ));
        assert_eq!(tag, b'p', "SASLInitialResponse");
        let mut initial = Reader::new(bytes::Bytes::from(body));
        assert_eq!(initial.cstr().unwrap(), SCRAM_SHA_256);
        let data = initial.rest();
        assert!(data[4..].starts_with(b"n,,"), "{data:?}");
        assert!(!data
            .windows(b"stub-password-marker".len())
            .any(|w| w == b"stub-password-marker"));
    }

    /// Only `N` to the SSL request means the server's SSL is off; any other
    /// answer is a failed TLS setup, never "switch to No encryption".
    #[tokio::test]
    async fn only_an_n_answer_means_ssl_is_off() {
        let target = DbTarget::from_credentials(
            r#"{"host":"db.example.com","port":5432,"database":"d","username":"u","password":"p","sslmode":"require"}"#,
        )
        .unwrap();
        for (answer, ssl_off) in [(b'N', true), (b'E', false), (b'H', false)] {
            let (client, mut server) = socket_pair().await;
            let stub = async {
                let mut request = [0u8; 8];
                server.read_exact(&mut request).await.unwrap();
                server.write_all(&[answer]).await.unwrap();
            };
            let (opened, ()) = tokio::join!(open_tls(client, &target), stub);
            match opened {
                Err(UpstreamError::NoTls) => assert!(ssl_off, "{}", char::from(answer)),
                Err(UpstreamError::Tls(_)) => assert!(!ssl_off, "{}", char::from(answer)),
                _ => panic!("unexpected result for {}", char::from(answer)),
            }
        }
    }

    /// Without TLS, only a SCRAM login is accepted. Run with
    /// `ONECLI_PG_LIVE_PLAIN=<port> GATEWAY_ALLOW_PRIVATE_DESTINATIONS=127.0.0.1`
    /// against an `ssl=off` server whose roles `scram` / `md5u` / `trustu`
    /// (passwords `scram-pw` / `md5-pw` / any) log in with those methods.
    #[tokio::test]
    #[ignore = "needs a live PostgreSQL server with ssl=off"]
    async fn without_tls_only_scram_logs_in_live() {
        let port: u16 = std::env::var("ONECLI_PG_LIVE_PLAIN")
            .unwrap()
            .parse()
            .unwrap();
        let target = |user: &str, password: &str, sslmode: &str| {
            DbTarget::from_credentials(&format!(
                r#"{{"host":"127.0.0.1","port":{port},"database":"postgres","username":"{user}","password":"{password}","sslmode":"{sslmode}"}}"#
            ))
            .unwrap()
        };
        let mut session = connect(&target("scram", "scram-pw", "disable"), &[])
            .await
            .expect("scram over plain");
        assert!(!session.conn.stream().encrypted());
        assert!(!role_powers(&mut session.conn).await.unwrap().superuser);
        for user in ["md5u", "trustu"] {
            assert!(
                matches!(
                    connect(&target(user, "md5-pw", "disable"), &[]).await,
                    Err(UpstreamError::WeakLoginWithoutTls)
                ),
                "{user} must be refused without TLS"
            );
        }
        // The same server under an encrypting mode says SSL is off.
        assert!(matches!(
            connect(&target("scram", "scram-pw", "require"), &[]).await,
            Err(UpstreamError::NoTls)
        ));
    }

    /// Logs in to a live TLS server. Run with
    /// `ONECLI_PG_LIVE=<port> GATEWAY_ALLOW_PRIVATE_DESTINATIONS=127.0.0.1`
    /// against a server whose roles `scram` / `md5u` (passwords `scram-pw` /
    /// `md5-pw`) log in with those methods over `hostssl`.
    #[tokio::test]
    #[ignore = "needs a live TLS PostgreSQL server"]
    async fn logs_in_live_with_scram_plus_and_md5() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let port: u16 = std::env::var("ONECLI_PG_LIVE").unwrap().parse().unwrap();
        let target = |user: &str, password: &str| {
            DbTarget::from_credentials(&format!(
                r#"{{"host":"127.0.0.1","port":{port},"database":"postgres","username":"{user}","password":"{password}","sslmode":"require"}}"#
            ))
            .unwrap()
        };
        for (user, password) in [("scram", "scram-pw"), ("md5u", "md5-pw")] {
            let mut session = connect(
                &target(user, password),
                &[("application_name", "onecli:test")],
            )
            .await
            .unwrap_or_else(|e| panic!("{user}: {e}"));
            assert!(!session.parameters.is_empty(), "{user}");
            let powers = role_powers(&mut session.conn).await.unwrap();
            assert!(!powers.superuser, "{user}");
        }
        // A role granted the server's programs reaches as far as a superuser.
        if let Ok(password) = std::env::var("ONECLI_PG_LIVE_PROGRAMS_ROLE") {
            let (user, password) = password.split_once(':').unwrap();
            let mut session = connect(&target(user, password), &[]).await.unwrap();
            assert!(role_powers(&mut session.conn).await.unwrap().superuser);
        }
        match connect(&target("scram", "wrong"), &[]).await {
            Err(UpstreamError::Rejected(message)) => {
                assert!(
                    message.contains("password authentication failed"),
                    "{message}"
                )
            }
            Err(other) => panic!("{other}"),
            Ok(_) => panic!("a wrong password logged in"),
        }
    }
}
