import type { MintedSshCertificate } from "@/lib/api/types";

/**
 * The one-paste connect command: write the minted certificate beside the
 * default key, then connect. `~/.ssh/id_ed25519-cert.pub` is deliberate —
 * OpenSSH auto-pairs `<key>-cert.pub` with the key for EVERY invocation
 * (VS Code Remote included) with zero config, and it is the exact file the
 * page's own `ssh-keygen -t ed25519` hint sets up. A OneCLI-named cert file
 * would need explicit -o CertificateFile flags and break that auto-pickup.
 */

// A minted certificate line is `<type> <base64>` — no quotes are possible in
// its charset — but the escaping stays: a shell command built from ANY
// interpolated value must be injection-proof by construction, not by the
// current shape of its inputs.
const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export const SSH_CERT_PATH = "~/.ssh/id_ed25519-cert.pub";

export const buildSshConnectCommand = (
  minted: Pick<MintedSshCertificate, "certificate" | "user" | "host" | "port">,
): string => {
  // Emit `-p` only for a non-default port: cloud is 22, so its command
  // stays byte-identical, and an older API that answers without a port is
  // treated as 22 too.
  const portFlag =
    minted.port !== undefined && minted.port !== 22 ? `-p ${minted.port} ` : "";
  return `printf '%s\\n' ${shellSingleQuote(minted.certificate)} > ${SSH_CERT_PATH} && ssh ${portFlag}${minted.user}@${minted.host}`;
};
