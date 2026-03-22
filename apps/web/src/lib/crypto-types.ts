export interface CryptoService {
  encrypt: (plaintext: string) => Promise<string>;
  decrypt: (encrypted: string) => Promise<string>;
}
