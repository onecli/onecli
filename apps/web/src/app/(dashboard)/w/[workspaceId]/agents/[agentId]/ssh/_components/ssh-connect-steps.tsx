"use client";

import { TryDemoCommand } from "@/app/(dashboard)/_components/try-demo-command";
import type { MintedSshCertificate } from "@/lib/api/types";
import { buildSshConnectCommand } from "@/lib/ssh-connect-command";

/**
 * What to do with a freshly minted certificate: ONE paste. The command saves
 * the certificate beside the default key (ssh auto-pairs `<key>-cert.pub`,
 * VS Code Remote included) and connects. The username is the server's word
 * (`minted.user`, the cert's principal), never re-derived client-side.
 */
export const SshConnectSteps = ({
  minted,
}: {
  minted: MintedSshCertificate;
}) => {
  // Date + time, not time-only: the TTL is deployment-configurable
  // (SSH_CERT_TTL_SECONDS), so a bare "3:47 PM" would be ambiguous the moment
  // an operator sets a window past a day — the honesty note below depends on
  // this reading correctly across the whole range.
  const validUntil = new Date(minted.expiresAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Connect</h3>
      <p className="text-muted-foreground mb-3 text-sm">
        Run this in your terminal. It saves the certificate next to your key and
        connects; scp, sftp and VS Code Remote SSH then work the same way: same
        host, same user.
      </p>
      <TryDemoCommand
        command={buildSshConnectCommand(minted)}
        highlight={`${minted.user}@${minted.host}`}
      />
      <p className="text-muted-foreground mt-2 text-xs">
        {/* The default-path assumption must be explicit and recoverable: a
            cert minted from a key that is NOT ~/.ssh/id_ed25519 would
            otherwise fail auth silently after this one-paste. */}
        This assumes your key is ~/.ssh/id_ed25519. If it lives elsewhere, save
        the certificate as {"<your-key>"}-cert.pub beside it instead.
      </p>
      <p className="text-muted-foreground mt-2 text-xs">
        {/* The real expiry, not a hardcoded "~10 minutes": the TTL is
            deployment-configurable and this line must stay honest. */}
        This certificate is valid until {validUntil}. Mint a new one for your
        next session; a session that is already open is not cut off when it
        expires.
      </p>
    </div>
  );
};
