import type { CryptoService } from "./types";
import { cryptoService as defaultCrypto } from "../lib/crypto";

let _crypto: CryptoService = defaultCrypto;

export const initCrypto = (c: CryptoService) => {
  _crypto = c;
};

export const getCrypto = (): CryptoService => _crypto;
