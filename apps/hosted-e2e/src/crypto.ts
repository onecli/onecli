/**
 * The ONPREM encryptor — the edition this suite runs. The fixtures must
 * write ciphertexts the spawned api-server and gateway can read: local
 * AES-256-GCM, 3-part `iv:authTag:ciphertext`, keyed by the
 * SECRET_ENCRYPTION_KEY vitest pins for every process in a scenario. The
 * gateway dispatches per ciphertext SHAPE (3-part = AES), so nothing here
 * needs an edition flag — unlike gateway-e2e, which hardcodes the KMS
 * envelope because its default lane is cloud.
 */
export { cryptoService } from "@onecli/api/lib/crypto";
