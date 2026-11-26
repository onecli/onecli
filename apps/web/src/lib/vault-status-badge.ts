// What a paired vault's status badge says, shared by the Vaults tab card and
// the provider's own page so the two never disagree.

export type StatusTone = "ok" | "warn" | "error";

export interface StatusBadge {
  label: string;
  tone: StatusTone;
}

interface StatusInput {
  lastError: string | null | undefined;
  /** Provider-specific reason the connection can't serve credentials (Keeper). */
  reason?: string | null;
  isReady: boolean;
}

export const vaultStatusBadge = ({
  lastError,
  reason,
  isReady,
}: StatusInput): StatusBadge => {
  // Generic on purpose: the vault can't always say why (expired, revoked,
  // unreachable), and naming one cause would mislead on the others.
  if (reason === "connection_failed")
    return { label: "Can't connect", tone: "error" };
  if (lastError) return { label: "Error", tone: "error" };
  if (reason === "no_records")
    return { label: "No records shared", tone: "warn" };
  return { label: isReady ? "Connected" : "Paired", tone: "ok" };
};

/** Within this long of its expiry, an access limit is flagged as a warning. */
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExpiryNotice {
  tone: StatusTone;
  text: string;
}

/** How to present an access expiry date, or `null` when there is none. */
export const expiryNotice = (
  expiresOn: string | null | undefined,
  now: Date = new Date(),
): ExpiryNotice | null => {
  if (!expiresOn) return null;
  const at = new Date(expiresOn);
  if (Number.isNaN(at.getTime())) return null;
  const date = at.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const left = at.getTime() - now.getTime();
  if (left <= 0)
    return { tone: "error", text: `Keeper access expired on ${date}.` };
  if (left <= EXPIRY_WARNING_MS)
    return { tone: "warn", text: `Keeper access expires on ${date}.` };
  return { tone: "ok", text: `Keeper access expires on ${date}.` };
};
