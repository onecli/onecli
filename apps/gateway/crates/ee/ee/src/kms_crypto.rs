//! KMS envelope encryption backend — hosted-platform plumbing, not an
//! entitlement-gated feature.
//!
//! The 4-part wire format `{encryptedDataKey}:{iv}:{authTag}:{ciphertext}`
//! matches the TypeScript `KmsCryptoService` (`packages/api/src/ee/kms-crypto.ts`):
//! KMS Decrypt recovers the data key, AES-256-GCM decrypts with it, then the
//! plaintext data key is zeroed. The shared [`crypto::CryptoService`]
//! owns backend SELECTION and format dispatch (a deployment configures exactly
//! one backend; every supported self-host path provisions
//! `SECRET_ENCRYPTION_KEY` and runs local AES — a keyless deployment falls
//! through to this backend regardless of edition); this module owns the KMS
//! mechanics, reusing the shared AES primitives.

use anyhow::{Context, Result};
use aws_sdk_kms::Client as KmsClient;
use base64::Engine;
use ring::aead;

use crypto::{aes_gcm_decrypt, check_iv_and_tag, seal_with_key};

/// Encryption context must match what the TypeScript side uses.
const ENCRYPTION_CONTEXT_KEY: &str = "purpose";
const ENCRYPTION_CONTEXT_VALUE: &str = "onecli-secret-encryption";

/// The KMS envelope backend: a KMS client plus the 4-part format mechanics.
pub struct KmsEnvelopeCrypto {
    client: KmsClient,
}

impl KmsEnvelopeCrypto {
    /// Build the backend from the environment: AWS credentials and region come
    /// from the standard SDK chain (env vars, instance metadata, ECS task
    /// role); `KMS_KEY_ARN` is read at encrypt time.
    pub async fn from_env() -> Self {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        Self {
            client: KmsClient::new(&config),
        }
    }
}

#[async_trait::async_trait]
impl crypto::EnvelopeCrypto for KmsEnvelopeCrypto {
    /// Decrypt the 4-part KMS envelope format: KMS Decrypt recovers the data
    /// key, AES-256-GCM decrypts with it, then the plaintext data key is zeroed.
    ///
    /// `parts` must hold exactly the 4 `:`-split segments — the `CryptoService`
    /// dispatch guarantees it; a shorter slice panics on indexing.
    async fn decrypt(&self, parts: &[&str]) -> Result<String> {
        debug_assert_eq!(parts.len(), 4, "KMS envelope dispatch sends 4 parts");
        let b64 = &base64::engine::general_purpose::STANDARD;

        let encrypted_data_key = b64
            .decode(parts[0])
            .context("invalid encrypted data key base64")?;
        let iv = b64.decode(parts[1]).context("invalid IV base64")?;
        let auth_tag = b64.decode(parts[2]).context("invalid auth tag base64")?;
        let ciphertext = b64.decode(parts[3]).context("invalid ciphertext base64")?;

        check_iv_and_tag(&iv, &auth_tag)?;

        let resp = self
            .client
            .decrypt()
            .ciphertext_blob(aws_sdk_kms::primitives::Blob::new(encrypted_data_key))
            .encryption_context(ENCRYPTION_CONTEXT_KEY, ENCRYPTION_CONTEXT_VALUE)
            .send()
            .await
            .context("KMS Decrypt failed")?;

        let mut data_key = resp
            .plaintext()
            .context("KMS Decrypt returned no plaintext")?
            .as_ref()
            .to_vec();

        let result = aes_gcm_decrypt(&data_key, &iv, &auth_tag, &ciphertext);

        // Zero out the plaintext data key
        data_key.fill(0);

        result
    }

    /// Encrypt to the 4-part KMS envelope format (requires `KMS_KEY_ARN`).
    /// Output is compatible with the matching TypeScript service and with
    /// [`crypto::CryptoService::decrypt`].
    async fn encrypt(&self, plaintext: &str) -> Result<String> {
        let key_arn = std::env::var("KMS_KEY_ARN").context("KMS_KEY_ARN env var not set")?;

        let resp = self
            .client
            .generate_data_key()
            .key_id(&key_arn)
            .key_spec(aws_sdk_kms::types::DataKeySpec::Aes256)
            .encryption_context(ENCRYPTION_CONTEXT_KEY, ENCRYPTION_CONTEXT_VALUE)
            .send()
            .await
            .context("KMS GenerateDataKey failed")?;

        let mut data_key = resp
            .plaintext()
            .context("KMS GenerateDataKey returned no plaintext")?
            .as_ref()
            .to_vec();

        let encrypted_data_key = resp
            .ciphertext_blob()
            .context("KMS GenerateDataKey returned no ciphertext blob")?
            .as_ref()
            .to_vec();

        let result = kms_envelope_encrypt(&data_key, &encrypted_data_key, plaintext);

        // Zero out the plaintext data key
        data_key.fill(0);

        result
    }
}

/// Encrypt to the 4-part KMS envelope format
/// `{encryptedDataKey}:{iv}:{authTag}:{ciphertext}` with a plaintext data key.
fn kms_envelope_encrypt(
    data_key: &[u8],
    encrypted_data_key: &[u8],
    plaintext: &str,
) -> Result<String> {
    let unbound_key = aead::UnboundKey::new(&aead::AES_256_GCM, data_key)
        .map_err(|_| anyhow::anyhow!("failed to create AES-256-GCM key from data key"))?;
    let key = aead::LessSafeKey::new(unbound_key);

    let (iv, in_out) = seal_with_key(&key, plaintext)?;
    let ciphertext = &in_out[..plaintext.len()];
    let auth_tag = &in_out[plaintext.len()..];

    let b64 = &base64::engine::general_purpose::STANDARD;
    Ok(format!(
        "{}:{}:{}:{}",
        b64.encode(encrypted_data_key),
        b64.encode(iv),
        b64.encode(auth_tag),
        b64.encode(ciphertext),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::{SecureRandom, SystemRandom};

    /// The envelope FORMAT round-trips without any KMS network call: seal with
    /// a raw data key, then open through the same shared AES primitive the
    /// decrypt path uses. Pins the moved format assembly (part order, base64,
    /// tag placement) against the TypeScript twin's shape.
    #[test]
    fn envelope_format_round_trips_with_a_raw_data_key() {
        let rng = SystemRandom::new();
        let mut data_key = [0u8; 32];
        rng.fill(&mut data_key).expect("generate data key");
        let fake_encrypted_key = b"opaque-kms-ciphertext-blob";

        let plaintext = r#"{"access_token":"ya29.new","refresh_token":"1//0e"}"#;
        let envelope =
            kms_envelope_encrypt(&data_key, fake_encrypted_key, plaintext).expect("encrypt");

        let parts: Vec<&str> = envelope.split(':').collect();
        assert_eq!(parts.len(), 4);
        let b64 = &base64::engine::general_purpose::STANDARD;
        assert_eq!(
            b64.decode(parts[0]).expect("decode edk"),
            fake_encrypted_key
        );

        let iv = b64.decode(parts[1]).expect("decode iv");
        let auth_tag = b64.decode(parts[2]).expect("decode tag");
        let ciphertext = b64.decode(parts[3]).expect("decode ct");
        check_iv_and_tag(&iv, &auth_tag).expect("lengths");
        let decrypted = aes_gcm_decrypt(&data_key, &iv, &auth_tag, &ciphertext).expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    // ── The TS↔Rust envelope contract, against the committed fixture ────────
    //
    // TypeScript writes the envelope (packages/api/src/ee/kms-crypto.ts), this
    // module opens it — and neither can import the other, so the contract is a
    // committed fixture both sides must open. The TS twin is
    // `kms-crypto.contract.test.ts`; `include_str!` shares the bytes exactly
    // like the policy corpus does. This pair replaced the E2E-against-a-KMS-
    // emulator guard when the E2E lane moved to the enterprise edition.

    /// The corpus-test pattern: six `..` from
    /// apps/gateway/crates/ee/ee/src/ reach the repo root.
    const FIXTURE: &str =
        include_str!("../../../../../../packages/api/src/ee/kms-envelope.fixture.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EnvelopeFixture {
        data_key_b64: String,
        encrypted_data_key_b64: String,
        encryption_context_key: String,
        encryption_context_value: String,
        plaintext: String,
        envelope: String,
    }

    fn fixture() -> EnvelopeFixture {
        serde_json::from_str(FIXTURE).expect("parse kms-envelope.fixture.json")
    }

    /// The decrypt path AFTER KMS: split, validate, open with the data key —
    /// the exact primitives `KmsEnvelopeCrypto::decrypt` applies once the
    /// KMS call has recovered the key.
    fn open_fixture_envelope(envelope: &str, data_key: &[u8]) -> Result<String> {
        let parts: Vec<&str> = envelope.split(':').collect();
        assert_eq!(parts.len(), 4, "the envelope must have 4 parts");
        let b64 = &base64::engine::general_purpose::STANDARD;
        let iv = b64.decode(parts[1]).context("invalid IV base64")?;
        let auth_tag = b64.decode(parts[2]).context("invalid auth tag base64")?;
        let ciphertext = b64.decode(parts[3]).context("invalid ciphertext base64")?;
        check_iv_and_tag(&iv, &auth_tag)?;
        aes_gcm_decrypt(data_key, &iv, &auth_tag, &ciphertext)
    }

    #[test]
    fn opens_the_envelope_typescript_wrote() {
        let f = fixture();
        let b64 = &base64::engine::general_purpose::STANDARD;
        let data_key = b64.decode(&f.data_key_b64).expect("decode data key");
        assert_eq!(data_key.len(), 32);

        let decrypted =
            open_fixture_envelope(&f.envelope, &data_key).expect("open the TS-written envelope");
        assert_eq!(decrypted, f.plaintext);

        // The first part is the (opaque) KMS-encrypted data key, byte-exact.
        let first = f.envelope.split(':').next().expect("first part");
        assert_eq!(first, f.encrypted_data_key_b64);
    }

    #[test]
    fn encryption_context_matches_the_fixture_pin() {
        // Both sides must send the same encryption context or KMS refuses the
        // decrypt. The fixture pins it; this module hardcodes it.
        let f = fixture();
        assert_eq!(ENCRYPTION_CONTEXT_KEY, f.encryption_context_key);
        assert_eq!(ENCRYPTION_CONTEXT_VALUE, f.encryption_context_value);
    }

    #[test]
    fn a_wrong_key_fails_to_open_the_fixture() {
        // Positive control: proves the contract test would detonate on drift
        // rather than pass vacuously.
        let f = fixture();
        let rng = SystemRandom::new();
        let mut wrong_key = [0u8; 32];
        rng.fill(&mut wrong_key).expect("generate key");
        assert!(open_fixture_envelope(&f.envelope, &wrong_key).is_err());
    }

    #[test]
    fn own_encrypt_writes_an_envelope_the_fixture_algorithm_opens() {
        // Round-trip through the production assembly with the FIXTURE's data
        // key: what this module writes, the fixture algorithm (and therefore
        // the TS side) opens.
        let f = fixture();
        let b64 = &base64::engine::general_purpose::STANDARD;
        let data_key = b64.decode(&f.data_key_b64).expect("decode data key");
        let encrypted_data_key = b64
            .decode(&f.encrypted_data_key_b64)
            .expect("decode encrypted data key");

        let envelope =
            kms_envelope_encrypt(&data_key, &encrypted_data_key, &f.plaintext).expect("encrypt");
        let decrypted = open_fixture_envelope(&envelope, &data_key).expect("open own envelope");
        assert_eq!(decrypted, f.plaintext);
    }
}
