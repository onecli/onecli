import { X509Certificate } from "node:crypto";

/**
 * Best-effort cert-expiry extraction from SAML IdP metadata. Considers only
 * signing (or use-less) KeyDescriptors, and returns the LATEST notAfter —
 * metadata routinely carries old+new certs during rotation, and the newest
 * one is the meaningful expiry. Returns null whenever parsing fails: the
 * value is advisory UI surface, never load-bearing.
 */
export const extractSamlCertExpiry = (metadataXml: string): Date | null => {
  try {
    const keyDescriptors =
      metadataXml.match(
        /<(?:[\w.-]+:)?KeyDescriptor[\s\S]*?<\/(?:[\w.-]+:)?KeyDescriptor>/g,
      ) ?? [];
    let latest: Date | null = null;
    for (const block of keyDescriptors) {
      const use = /\buse\s*=\s*"(\w+)"/.exec(block)?.[1];
      if (use && use !== "signing") continue;
      const certMatch =
        /<(?:[\w.-]+:)?X509Certificate>([\s\S]*?)<\/(?:[\w.-]+:)?X509Certificate>/.exec(
          block,
        );
      if (!certMatch?.[1]) continue;
      const b64 = certMatch[1].replace(/\s+/g, "");
      const pem = `-----BEGIN CERTIFICATE-----\n${b64.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`;
      const cert = new X509Certificate(pem);
      const notAfter = new Date(cert.validTo);
      if (!Number.isNaN(notAfter.getTime()) && (!latest || notAfter > latest)) {
        latest = notAfter;
      }
    }
    return latest;
  } catch {
    return null;
  }
};

/** Cheap shape check: does this look like SAML IdP metadata at all? */
export const looksLikeSamlMetadata = (xml: string): boolean =>
  /<(?:[\w.-]+:)?EntityDescriptor[\s>]/.test(xml);
