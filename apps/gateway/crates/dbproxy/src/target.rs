//! A database connection as the gateway dials it: the stored settings of one
//! `app_connections` row, decrypted, decoded and validated.
//!
//! The shape is engine-agnostic (every SQL server has a host, port, database,
//! user and password); the engine adapter reads it and speaks its own wire.
//! Validation happens here, once, for every engine: a connection with a
//! malformed host or an unknown TLS mode never reaches a dial.

use std::fmt;

use serde::Deserialize;

/// How the gateway authenticates the database server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    /// TLS, and the server's certificate must chain to a trusted root
    /// (the public web roots, or the connection's own CA) AND name the host.
    VerifyFull,
    /// TLS, the server's certificate unchecked. For servers on a private
    /// network with a self-signed certificate and no CA to pin.
    Require,
    /// No TLS: the user's explicit choice for a server that has SSL off.
    /// Statements and results cross the network readable and alterable. The
    /// login is held to SCRAM-SHA-256, so the password itself is never sent
    /// (an observer can still guess a weak one offline), and MD5, cleartext
    /// and `trust` logins are refused. Never a default.
    Disable,
}

impl TlsMode {
    /// Whether the gateway opens TLS to the server at all.
    #[must_use]
    pub fn encrypts(self) -> bool {
        !matches!(self, Self::Disable)
    }
}

/// One connection's stored settings, as the connect form writes them.
#[derive(Clone, Deserialize)]
pub struct DbTarget {
    pub host: String,
    #[serde(
        default = "default_port",
        deserialize_with = "port_from_number_or_text"
    )]
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
    #[serde(rename = "sslmode")]
    pub tls: TlsMode,
    /// PEM, when the server's certificate chains to a private CA.
    #[serde(default, rename = "sslrootcert")]
    pub ca_certificate: Option<String>,
}

/// Never print the password, even at debug level.
impl fmt::Debug for DbTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DbTarget")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .field("tls", &self.tls)
            .field(
                "ca_certificate",
                &self.ca_certificate.as_ref().map(|_| "<pem>"),
            )
            .finish()
    }
}

/// Why a stored connection cannot be dialed. Shown to the agent, so it names
/// the problem and the fix without echoing a stored value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetError {
    Unreadable,
    InvalidHost,
    MissingField(&'static str),
}

impl fmt::Display for TargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable => f.write_str(
                "the stored connection settings could not be read; reconnect it in the OneCLI dashboard",
            ),
            Self::InvalidHost => f.write_str(
                "the stored host is not a valid hostname or IP address; reconnect it in the OneCLI dashboard",
            ),
            Self::MissingField(field) => write!(
                f,
                "the stored connection has no {field}; reconnect it in the OneCLI dashboard"
            ),
        }
    }
}

impl std::error::Error for TargetError {}

fn default_port() -> u16 {
    5432
}

/// Connect forms submit every field as text; accept `5432` and `"5432"`.
fn port_from_number_or_text<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Port {
        Number(u16),
        Text(String),
    }
    match Port::deserialize(deserializer)? {
        Port::Number(port) => Ok(port),
        Port::Text(text) if text.trim().is_empty() => Ok(default_port()),
        Port::Text(text) => text.trim().parse().map_err(serde::de::Error::custom),
    }
}

impl DbTarget {
    /// Decode and validate a connection's decrypted credentials JSON. The
    /// connect form stores what was typed, so surrounding whitespace is
    /// trimmed from every field but the password, where it can be part of
    /// the secret.
    pub fn from_credentials(json: &str) -> Result<Self, TargetError> {
        let mut target: Self = serde_json::from_str(json).map_err(|_| TargetError::Unreadable)?;
        for field in [&mut target.host, &mut target.database, &mut target.username] {
            let trimmed = field.trim();
            if trimmed.len() != field.len() {
                *field = trimmed.to_string();
            }
        }
        target.validate()?;
        Ok(target)
    }

    fn validate(&self) -> Result<(), TargetError> {
        if self.port == 0 {
            return Err(TargetError::Unreadable);
        }
        if !is_dialable_host(&self.host) {
            return Err(TargetError::InvalidHost);
        }
        for (field, value) in [
            ("database", &self.database),
            ("username", &self.username),
            ("password", &self.password),
        ] {
            if value.is_empty() {
                return Err(TargetError::MissingField(field));
            }
        }
        Ok(())
    }
}

/// A bare hostname or IP literal: nothing URL-shaped, no port, no userinfo.
/// The same rule the connect form enforces, re-checked here because the
/// gateway dials whatever the row says.
fn is_dialable_host(host: &str) -> bool {
    if host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(host: &str) -> String {
        serde_json::json!({
            "host": host,
            "port": 5432,
            "database": "app",
            "username": "agent",
            "password": "s3cret",
            "sslmode": "verify-full",
        })
        .to_string()
    }

    #[test]
    fn a_stored_connection_decodes() {
        let target = DbTarget::from_credentials(&creds("db.example.com")).unwrap();
        assert_eq!(target.host, "db.example.com");
        assert_eq!(target.port, 5432);
        assert_eq!(target.tls, TlsMode::VerifyFull);
        assert!(target.ca_certificate.is_none());
    }

    #[test]
    fn a_port_stored_as_form_text_decodes() {
        let mut value: serde_json::Value = serde_json::from_str(&creds("db.example.com")).unwrap();
        value["port"] = " 6543 ".into();
        assert_eq!(
            DbTarget::from_credentials(&value.to_string()).unwrap().port,
            6543
        );
        value["port"] = " ".into();
        assert_eq!(
            DbTarget::from_credentials(&value.to_string()).unwrap().port,
            5432
        );
        value.as_object_mut().unwrap().remove("port");
        assert_eq!(
            DbTarget::from_credentials(&value.to_string()).unwrap().port,
            5432
        );
        value["port"] = 0.into();
        assert!(DbTarget::from_credentials(&value.to_string()).is_err());
        value["port"] = "70000".into();
        assert_eq!(
            DbTarget::from_credentials(&value.to_string()).unwrap_err(),
            TargetError::Unreadable
        );
    }

    #[test]
    fn the_password_never_prints() {
        let target = DbTarget::from_credentials(&creds("db.example.com")).unwrap();
        let debug = format!("{target:?}");
        assert!(!debug.contains("s3cret"), "{debug}");
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn typed_whitespace_is_trimmed_except_in_the_password() {
        let json = serde_json::json!({
            "host": " db.example.com\n",
            "port": "5432",
            "database": " app ",
            "username": "agent ",
            "password": " pass phrase ",
            "sslmode": "require",
        })
        .to_string();
        let target = DbTarget::from_credentials(&json).unwrap();
        assert_eq!(target.host, "db.example.com");
        assert_eq!(target.database, "app");
        assert_eq!(target.username, "agent");
        assert_eq!(target.password, " pass phrase ");
    }

    #[test]
    fn hosts_must_be_bare_names_or_ips() {
        for ok in [
            "db.example.com",
            "10.0.0.5",
            "::1",
            "db-1",
            "xn--bcher-kva.example",
        ] {
            assert!(DbTarget::from_credentials(&creds(ok)).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "db.example.com:5432",
            "postgres://db.example.com",
            "user@db.example.com",
            "db..example.com",
            "-db.example.com",
            "db.example.com/x",
            "db example.com",
        ] {
            assert_eq!(
                DbTarget::from_credentials(&creds(bad)).unwrap_err(),
                TargetError::InvalidHost,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn unknown_tls_modes_and_missing_fields_are_refused() {
        let mut value: serde_json::Value = serde_json::from_str(&creds("db.example.com")).unwrap();
        // `disable` is a deliberate, stored choice (SCRAM-only login), so it
        // parses; anything outside the three modes still does not.
        value["sslmode"] = "disable".into();
        let target = DbTarget::from_credentials(&value.to_string()).unwrap();
        assert_eq!(target.tls, TlsMode::Disable);
        assert!(!target.tls.encrypts());
        value["sslmode"] = "prefer".into();
        assert_eq!(
            DbTarget::from_credentials(&value.to_string()).unwrap_err(),
            TargetError::Unreadable,
            "only the three stored modes are ever dialed"
        );
        let mut value: serde_json::Value = serde_json::from_str(&creds("db.example.com")).unwrap();
        value["password"] = "".into();
        assert_eq!(
            DbTarget::from_credentials(&value.to_string()).unwrap_err(),
            TargetError::MissingField("password")
        );
    }
}
