//! AES-256-GCM decryption for secrets.
//!
//! Decrypts values encrypted by the Node.js `CryptoService` (in `lib/crypto.ts`).
//! Format: `{iv_b64}:{authTag_b64}:{ciphertext_b64}` (all base64-encoded).
//!
//! Uses `ring::aead` (already a transitive dependency via rustls).
//! The key comes from the `SECRET_ENCRYPTION_KEY` env var (base64-encoded, 32 bytes).

use anyhow::{bail, Context, Result};
use base64::Engine;
use ring::aead;

const KEY_LEN: usize = 32;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Service for decrypting AES-256-GCM encrypted secrets.
pub(crate) struct CryptoService {
    key: aead::LessSafeKey,
}

impl CryptoService {
    /// Create a CryptoService from the `SECRET_ENCRYPTION_KEY` environment variable.
    pub fn from_env() -> Result<Self> {
        let key_b64 = std::env::var("SECRET_ENCRYPTION_KEY")
            .context("SECRET_ENCRYPTION_KEY env var not set")?;
        Self::from_base64_key(&key_b64)
    }

    /// Create a CryptoService from a base64-encoded key.
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

        Ok(Self { key })
    }

    /// Decrypt a value in the format `{iv_b64}:{authTag_b64}:{ciphertext_b64}`.
    ///
    /// Note: `ring` expects ciphertext || tag concatenated (not separate).
    /// Node.js outputs them separately, so we concatenate before decrypting.
    pub fn decrypt(&self, encrypted: &str) -> Result<String> {
        let parts: Vec<&str> = encrypted.splitn(3, ':').collect();
        if parts.len() != 3 {
            bail!("invalid encrypted format: expected iv:authTag:ciphertext");
        }

        let b64 = &base64::engine::general_purpose::STANDARD;

        let iv = b64.decode(parts[0]).context("invalid IV base64")?;
        let auth_tag = b64.decode(parts[1]).context("invalid auth tag base64")?;
        let ciphertext = b64.decode(parts[2]).context("invalid ciphertext base64")?;

        if iv.len() != IV_LEN {
            bail!("invalid IV length: expected {IV_LEN}, got {}", iv.len());
        }
        if auth_tag.len() != TAG_LEN {
            bail!(
                "invalid auth tag length: expected {TAG_LEN}, got {}",
                auth_tag.len()
            );
        }

        let nonce = aead::Nonce::try_assume_unique_for_key(&iv)
            .map_err(|_| anyhow::anyhow!("invalid nonce"))?;

        // ring expects ciphertext || tag concatenated
        let mut in_out = Vec::with_capacity(ciphertext.len() + auth_tag.len());
        in_out.extend_from_slice(&ciphertext);
        in_out.extend_from_slice(&auth_tag);

        let plaintext = self
            .key
            .open_in_place(nonce, aead::Aad::empty(), &mut in_out)
            .map_err(|_| anyhow::anyhow!("decryption failed: invalid key or corrupted data"))?;

        String::from_utf8(plaintext.to_vec()).context("decrypted value is not valid UTF-8")
    }
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

    #[test]
    fn decrypt_round_trip() {
        let key_b64 = random_key_b64();
        let plaintext = "sk-ant-api03-test-key-1234567890";

        let encrypted = encrypt_like_nodejs(&key_b64, plaintext);
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        let decrypted = service.decrypt(&encrypted).expect("decrypt");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_empty_plaintext() {
        let key_b64 = random_key_b64();
        let encrypted = encrypt_like_nodejs(&key_b64, "");
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        let decrypted = service.decrypt(&encrypted).expect("decrypt");
        assert_eq!(decrypted, "");
    }

    #[test]
    fn decrypt_unicode() {
        let key_b64 = random_key_b64();
        let plaintext = "héllo wörld 🔑";
        let encrypted = encrypt_like_nodejs(&key_b64, plaintext);
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        let decrypted = service.decrypt(&encrypted).expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let key1 = random_key_b64();
        let key2 = random_key_b64();

        let encrypted = encrypt_like_nodejs(&key1, "secret");
        let service = CryptoService::from_base64_key(&key2).expect("create service");
        assert!(service.decrypt(&encrypted).is_err());
    }

    #[test]
    fn decrypt_corrupted_ciphertext_fails() {
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
        assert!(service.decrypt(&corrupted_encrypted).is_err());
    }

    #[test]
    fn invalid_format_missing_parts() {
        let key_b64 = random_key_b64();
        let service = CryptoService::from_base64_key(&key_b64).expect("create service");
        assert!(service.decrypt("only_one_part").is_err());
        assert!(service.decrypt("two:parts").is_err());
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
