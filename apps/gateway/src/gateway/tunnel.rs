//! TCP tunnel: splice bytes between client and upstream without inspection.

use anyhow::{Context, Result};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tracing::info;

/// Connect to the target server and splice bytes in both directions
/// until either side closes the connection. Used for non-intercepted domains.
pub(super) async fn tunnel(upgraded: hyper::upgrade::Upgraded, host: &str) -> Result<()> {
    let mut server = TcpStream::connect(host)
        .await
        .with_context(|| format!("connecting to upstream {host}"))?;

    let mut client = TokioIo::new(upgraded);

    let (client_to_server, server_to_client) =
        tokio::io::copy_bidirectional(&mut client, &mut server)
            .await
            .context("bidirectional copy")?;

    info!(
        host = %host,
        client_to_server,
        server_to_client,
        "tunnel closed"
    );

    Ok(())
}
