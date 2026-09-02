//! Secret encryption/decryption — local AES-256-GCM and KMS envelope.
//!
//! Two wire formats coexist (all parts base64-encoded, `:`-separated, and
//! base64 never contains `:` — so the part count identifies the format):
//!
//! * **3 parts** `{iv}:{authTag}:{ciphertext}` — local AES-256-GCM with the
//!   `SECRET_ENCRYPTION_KEY` env key (32 bytes, base64). Matches the Node.js
//!   `CryptoService` (`lib/crypto.ts`).
//! * **4 parts** `{encryptedDataKey}:{iv}:{authTag}:{ciphertext}` — KMS
//!   envelope. The mechanics live in the licensed
//!   licensed `ee::kms_crypto` (hosted-platform plumbing), matching the
//!   TypeScript `KmsCryptoService` (`packages/api/src/ee/kms-crypto.ts`);
//!   this crate owns the format dispatch; the composition root selects the
//!   backend (see `EnvelopeCrypto`).
//!
//! The composition root (`wiring::create_crypto_service`) configures exactly
//! ONE backend — local AES when
//! `SECRET_ENCRYPTION_KEY` is set, else KMS envelope (requires `KMS_KEY_ARN`
//! plus AWS config at call time); construction is either/or, never both.
//! **Decrypt** dispatches on the ciphertext's part count only to IDENTIFY the
//! format: a row written by the other backend fails with a clear cross-format
//! error — "secret uses the local AES format (iv:authTag:ciphertext) but
//! `SECRET_ENCRYPTION_KEY` is not configured on this deployment", or "secret
//! uses the KMS envelope format (encryptedDataKey:iv:authTag:ciphertext) but
//! this deployment is configured for local AES (SECRET_ENCRYPTION_KEY) without
//! KMS" — never a cross-backend decryption. Migrating a deployment from one
//! backend to the other therefore requires re-encrypting every stored row.
//!
//! Uses `ring::aead` (already a transitive dependency via rustls).

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use ring::aead;
use ring::rand::{SecureRandom, SystemRandom};

/// The 4-part envelope backend seam. The licensed KMS implementation
/// (`ee::kms_crypto`) implements this; the composition root (`wiring`)
/// injects it when the deployment is keyless. This module never names the
/// licensed type.
#[async_trait]
pub trait EnvelopeCrypto: Send + Sync {
    /// Decrypt the 4-part `{encryptedDataKey}:{iv}:{authTag}:{ciphertext}`.
    async fn decrypt(&self, parts: &[&str]) -> Result<String>;
    /// Encrypt to the 4-part envelope format.
    async fn encrypt(&self, plaintext: &str) -> Result<String>;
}

const KEY_LEN: usize = 32;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Service for encrypting/decrypting secrets with whichever backend the
/// deployment configures (see the module docs).
pub struct CryptoService {
    /// Local AES-256-GCM key from `SECRET_ENCRYPTION_KEY`, when configured.
    aes: Option<aead::LessSafeKey>,
    /// Envelope (KMS) backend, when the AES key is not configured.
    kms: Option<Box<dyn EnvelopeCrypto>>,
}

impl CryptoService {
    /// Create a CryptoService with the given envelope backend (KMS). Used by
    /// the composition root when `SECRET_ENCRYPTION_KEY` is not configured.
    pub fn from_envelope_backend(kms: Box<dyn EnvelopeCrypto>) -> Self {
        Self {
            aes: None,
            kms: Some(kms),
        }
    }

    /// Create an AES-only CryptoService from a base64-encoded 32-byte key.
    pub fn from_base64_key(key_b64: &str) -> Result<Self> {
        let key_bytes = base64::engine::general_purpose::STANDARD
            .decode(key_b64)
            .context("SECRET_ENCRYPTION_KEY is not valid base64")?;

        if key_bytes.len() != KEY_LEN {
            bail!(
                "SECRET_ENCRYPTION_KEY must be exactly {KEY_LEN} bytes (got {})",
                key_bytes.len()
            );
        }

        let unbound_key = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes)
            .map_err(|_| anyhow::anyhow!("failed to create AES-256-GCM key"))?;
        let key = aead::LessSafeKey::new(unbound_key);

        Ok(Self {
            aes: Some(key),
            kms: None,
        })
    }

    /// Decrypt a value, dispatching on its part count (3 = local AES, 4 = KMS
    /// envelope) to identify the format. Only the configured backend's format
    /// decrypts; the other fails with the clear cross-format error described
    /// in the module docs.
    pub async fn decrypt(&self, encrypted: &str) -> Result<String> {
        let parts: Vec<&str> = encrypted.split(':').collect();
        match parts.len() {
            3 => self.decrypt_aes(&parts),
            4 => match self.kms.as_ref() {
                Some(kms) => kms.decrypt(&parts).await,
                None => bail!(
                    "secret uses the KMS envelope format \
                     (encryptedDataKey:iv:authTag:ciphertext) but this deployment is \
                     configured for local AES (SECRET_ENCRYPTION_KEY) without KMS"
                ),
            },
            _ => bail!(
                "invalid encrypted format: expected iv:authTag:ciphertext or \
                 encryptedDataKey:iv:authTag:ciphertext"
            ),
        }
    }

    /// Decrypt the 3-part local AES format.
    ///
    /// Note: `ring` expects ciphertext || tag concatenated (not separate).
    /// Node.js outputs them separately, so we concatenate before decrypting.
    fn decrypt_aes(&self, parts: &[&str]) -> Result<String> {
        let Some(key) = self.aes.as_ref() else {
            bail!(
                "secret uses the local AES format (iv:authTag:ciphertext) but \
                 SECRET_ENCRYPTION_KEY is not configured on this deployment"
            );
        };

        let b64 = &base64::engine::general_purpose::STANDARD;

        let iv = b64.decode(parts[0]).context("invalid IV base64")?;
        let auth_tag = b64.decode(parts[1]).context("invalid auth tag base64")?;
        let ciphertext = b64.decode(parts[2]).context("invalid ciphertext base64")?;

        check_iv_and_tag(&iv, &auth_tag)?;
        open_with_key(key, &iv, &auth_tag, &ciphertext)
    }

    /// Encrypt a plaintext string with the configured backend: local AES
    /// (3-part format) when `SECRET_ENCRYPTION_KEY` is set, else KMS envelope
    /// (4-part format, requires `KMS_KEY_ARN`). Output is compatible with the
    /// matching TypeScript service and with this struct's `decrypt`.
    pub async fn encrypt(&self, plaintext: &str) -> Result<String> {
        if let Some(key) = self.aes.as_ref() {
            return encrypt_aes(key, plaintext);
        }

        let Some(kms) = self.kms.as_ref() else {
            // Unreachable by construction (from_env/from_base64_key always set
            // one backend), but fail clearly rather than panic.
            bail!("no encryption backend configured");
        };

        kms.encrypt(plaintext).await
    }
}

// ── AES helpers (shared by both backends) ───────────────────────────────

/// Validate IV and auth tag lengths before touching the cipher.
/// `pub(crate)`: the licensed KMS backend (`ee::kms_crypto`) validates
/// the same envelope parts.
pub fn check_iv_and_tag(iv: &[u8], auth_tag: &[u8]) -> Result<()> {
    if iv.len() != IV_LEN {
        bail!("invalid IV length: expected {IV_LEN}, got {}", iv.len());
    }
    if auth_tag.len() != TAG_LEN {
        bail!(
            "invalid auth tag length: expected {TAG_LEN}, got {}",
            auth_tag.len()
        );
    }
    Ok(())
}

/// AES-256-GCM open with an already-built key.
/// `ring` expects ciphertext || tag concatenated, so we join them here.
fn open_with_key(
    key: &aead::LessSafeKey,
    iv: &[u8],
    auth_tag: &[u8],
    ciphertext: &[u8],
) -> Result<String> {
    let nonce =
        aead::Nonce::try_assume_unique_for_key(iv).map_err(|_| anyhow::anyhow!("invalid nonce"))?;

    let mut in_out = Vec::with_capacity(ciphertext.len() + auth_tag.len());
    in_out.extend_from_slice(ciphertext);
    in_out.extend_from_slice(auth_tag);

    let plaintext = key
        .open_in_place(nonce, aead::Aad::empty(), &mut in_out)
        .map_err(|_| anyhow::anyhow!("decryption failed: invalid key or corrupted data"))?;

    String::from_utf8(plaintext.to_vec()).context("decrypted value is not valid UTF-8")
}

/// AES-256-GCM decrypt with raw key bytes (the KMS data key).
/// `pub(crate)`: the licensed KMS backend opens envelopes with it.
pub fn aes_gcm_decrypt(
    key_bytes: &[u8],
    iv: &[u8],
    auth_tag: &[u8],
    ciphertext: &[u8],
) -> Result<String> {
    let unbound_key = aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes)
        .map_err(|_| anyhow::anyhow!("failed to create AES-256-GCM key from data key"))?;
    let key = aead::LessSafeKey::new(unbound_key);
    open_with_key(&key, iv, auth_tag, ciphertext)
}

/// AES-256-GCM seal: returns `(iv, auth_tag, ciphertext)` raw parts.
/// `pub(crate)`: the licensed KMS backend seals envelopes with it.
pub fn seal_with_key(key: &aead::LessSafeKey, plaintext: &str) -> Result<([u8; IV_LEN], Vec<u8>)> {
    let rng = SystemRandom::new();
    let mut iv = [0u8; IV_LEN];
    rng.fill(&mut iv)
        .map_err(|_| anyhow::anyhow!("failed to generate random IV"))?;

    let nonce = aead::Nonce::try_assume_unique_for_key(&iv)
        .map_err(|_| anyhow::anyhow!("invalid nonce"))?;

    let mut in_out = plaintext.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut in_out)
        .map_err(|_| anyhow::anyhow!("encryption failed"))?;

    // ring appends the 16-byte auth tag after the ciphertext.
    Ok((iv, in_out))
}

/// Encrypt to the 3-part local AES format `{iv}:{authTag}:{ciphertext}`.
fn encrypt_aes(key: &aead::LessSafeKey, plaintext: &str) -> Result<String> {
    let (iv, in_out) = seal_with_key(key, plaintext)?;
    let ciphertext = &in_out[..plaintext.len()];
    let auth_tag = &in_out[plaintext.len()..];

    let b64 = &base64::engine::general_purpose::STANDARD;
    Ok(format!(
        "{}:{}:{}",
        b64.encode(iv),
        b64.encode(auth_tag),
        b64.encode(ciphertext),
    ))
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::{SecureRandom, SystemRandom};

    /// Generate a random 32-byte key and return it as base64.
    fn random_key_b64() -> String {
        let rng = SystemRandom::new();
        let mut key = [0u8; KEY_LEN];
        rng.fill(&mut key).expect("generate random key");
        base64::engine::general_purpose::STANDARD.encode(key)
    }

    /// Encrypt a plaintext using the same format as Node.js `lib/crypto.ts`.
    /// Returns `{iv_b64}:{authTag_b64}:{ciphertext_b64}`.
    fn encrypt_like_nodejs(key_b64: &str, plaintext: &str) -> String {
        let key_bytes = base64::engine::general_purpose::STANDARD
            .decode(key_b64)
            .expect("decode key");

        let rng = SystemRandom::new();
        let mut iv = [0u8; IV_LEN];
        rng.fill(&mut iv).expect("generate IV");

        let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes).expect("create key");
        let key = aead::LessSafeKey::new(unbound);

        let nonce = aead::Nonce::try_assume_unique_for_key(&iv).expect("create nonce");

        let mut in_out = plaintext.as_bytes().to_vec();
        // ring appends the tag to in_out
        key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut in_out)
            .expect("encrypt");

        // Split: ciphertext is first (plaintext.len() bytes), tag is last TAG_LEN bytes
        let ciphertext = &in_out[..plaintext.len()];
        let auth_tag = &in_out[plaintext.len()..];

        let b64 = &base64::engine::general_purpose::STANDARD;
        format!(
            "{}:{}:{}",
            b64.encode(iv),
            b64.encode(auth_tag),
            b64.encode(ciphertext),
        )
    }

    #[tokio::test]
    async fn encrypt_decrypt_round_trip() {
        let key_b64 = random_key_b64();
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");

        let plaintext =
            r#"{"access_token":"ya29.new","refresh_token":"1//0e","expires_at":1700000000}"#;
        let encrypted = service.encrypt(plaintext).await.expect("encrypt");

        // Verify format: 3 base64 parts separated by colons
        assert_eq!(encrypted.split(':').count(), 3);

        let decrypted = service.decrypt(&encrypted).await.expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[tokio::test]
    async fn decrypt_round_trip() {
        let key_b64 = random_key_b64();
        let plaintext = "sk-ant-api03-test-key-1234567890";

        let encrypted = encrypt_like_nodejs(&key_b64, plaintext);
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        let decrypted = service.decrypt(&encrypted).await.expect("decrypt");

        assert_eq!(decrypted, plaintext);
    }

    #[tokio::test]
    async fn decrypt_empty_plaintext() {
        let key_b64 = random_key_b64();
        let encrypted = encrypt_like_nodejs(&key_b64, "");
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        let decrypted = service.decrypt(&encrypted).await.expect("decrypt");
        assert_eq!(decrypted, "");
    }

    #[tokio::test]
    async fn decrypt_unicode() {
        let key_b64 = random_key_b64();
        let plaintext = "héllo wörld 🔑";
        let encrypted = encrypt_like_nodejs(&key_b64, plaintext);
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        let decrypted = service.decrypt(&encrypted).await.expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[tokio::test]
    async fn decrypt_wrong_key_fails() {
        let key1 = random_key_b64();
        let key2 = random_key_b64();

        let encrypted = encrypt_like_nodejs(&key1, "secret");
        let service = CryptoService::from_base64_key(&key2).expect("create service");
        assert!(service.decrypt(&encrypted).await.is_err());
    }

    #[tokio::test]
    async fn decrypt_corrupted_ciphertext_fails() {
        let key_b64 = random_key_b64();
        let encrypted = encrypt_like_nodejs(&key_b64, "secret");

        // Corrupt the ciphertext portion
        let parts: Vec<&str> = encrypted.splitn(3, ':').collect();
        let mut ciphertext = base64::engine::general_purpose::STANDARD
            .decode(parts[2])
            .expect("decode");
        if let Some(b) = ciphertext.first_mut() {
            *b ^= 0xff;
        }
        let corrupted = base64::engine::general_purpose::STANDARD.encode(&ciphertext);
        let corrupted_encrypted = format!("{}:{}:{}", parts[0], parts[1], corrupted);

        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        assert!(service.decrypt(&corrupted_encrypted).await.is_err());
    }

    #[tokio::test]
    async fn invalid_format_missing_parts() {
        let key_b64 = random_key_b64();
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        assert!(service.decrypt("only_one_part").await.is_err());
        assert!(service.decrypt("two:parts").await.is_err());
        assert!(service.decrypt("a:b:c:d:e").await.is_err());
    }

    #[tokio::test]
    async fn kms_format_without_kms_backend_errors_clearly() {
        // An AES-configured service asked to decrypt a 4-part (KMS envelope)
        // row must say what is missing, not report a generic parse failure.
        let key_b64 = random_key_b64();
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        let err = service
            .decrypt("ZWRr:aXY=:dGFn:Y3Q=")
            .await
            .expect_err("4-part input must fail without KMS");
        assert!(err.to_string().contains("KMS"), "got: {err}");
    }

    #[test]
    fn invalid_key_length() {
        let short_key = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        assert!(CryptoService::from_base64_key(&short_key).is_err());
    }

    #[test]
    fn invalid_base64_key() {
        assert!(CryptoService::from_base64_key("not-valid-base64!!!").is_err());
    }
}
