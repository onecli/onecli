import type { CryptoService } from "./types";
import { cryptoService as localCrypto } from "../lib/crypto";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud encrypts with KMS envelope encryption (injected by
// `ensureEditionDefaults()` — the KMS module must never enter a client
// bundle, so it is not imported here); onprem uses the local AES service.
// `initCrypto` remains as a test seam (null resets to the edition default).
const slot = createEditionSlot<CryptoService>("crypto", () => localCrypto);

export const initCrypto = (c: CryptoService | null) => slot.init(c);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultCrypto = (c: CryptoService) => slot.setCloudDefault(c);

export const getCrypto = (): CryptoService => slot.get();
