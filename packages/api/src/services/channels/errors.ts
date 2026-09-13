/**
 * Channel error vocabulary — the base class now lives in `@onecli/channels`
 * (both runtimes need it below the api). Re-exported here so the api's
 * internal importers keep one conventional path; new code may import from
 * either.
 */
import type { ChannelProviderId } from "@onecli/channels";

export { ChannelProviderApiError } from "@onecli/channels";

/**
 * A stored org automation credential the provider has PROVEN unusable — the
 * one signal that lets the generic rotation layer clear it and surface the
 * re-paste state. Everything else a rotation throws (a transient provider
 * refusal, a 5xx, a timeout) is a reason to try again later, never to wipe a
 * pair the org is still entitled to use.
 *
 * Neutral by design: the provider decides what "dead" means on its wire
 * (Slack: the refresh half refused as invalid, or an unusable pair whose
 * access half already expired) and reports it through this class, so the
 * generic service branches on `instanceof` without knowing any provider's
 * error codes.
 */
export class DeadIntegrationCredentialError extends Error {
  constructor(
    public readonly providerId: ChannelProviderId,
    /** The provider's own reason (its error code, or a short label such as
     * `unreadable`) — for the log line, never for the user. */
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`${providerId} integration credential is dead: ${reason}`, options);
    this.name = "DeadIntegrationCredentialError";
  }
}
