import { isOnpremEdition } from "../../lib/policy-flags";
import { getSelfUrl } from "../../providers/self-url";
import { ServiceError } from "../errors";
import type { ChannelTransport } from "./types";

/**
 * The deployment's transport posture (§step-6 decision 7). Two independent
 * questions decide what a NEW presence may use:
 *
 * - "events" (webhooks) needs the provider to reach this API over public
 *   HTTPS — a config-presence signal (the house rule: config beats edition
 *   where honest): cloud and a TLS'd self-host both qualify; a laptop on
 *   localhost does not.
 * - "socket" is self-host only — a product decision with no natural config
 *   signal (the hosted platform's adapter fleet could hold the sockets, we
 *   just don't offer it), so this one IS a deliberate edition read.
 *
 * `getSelfUrl()` is the API's own configured origin (`apps/api-server`
 * initializes it from `API_URL`), which is exactly the URL the provider would
 * be given to call back — so the answer and the baked manifest URL can never
 * disagree.
 */
export const publicApiUrl = (): string | null => {
  const url = getSelfUrl();
  try {
    return new URL(url).protocol === "https:" ? url.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
};

/** The transports a NEW presence may be stamped with, events first. */
export const availableTransports = (): ChannelTransport[] => [
  ...(publicApiUrl() !== null ? (["events"] as const) : []),
  ...(isOnpremEdition() ? (["socket"] as const) : []),
];

/** Which transport a NEW presence gets by default. Existing presences keep
 * their stamp — the provider-side app config baked one, so switching is
 * detach/re-attach. */
export const defaultTransport = (): ChannelTransport =>
  publicApiUrl() ? "events" : "socket";

/**
 * The one gate every stamping path goes through: an omitted request keeps
 * today's default; an explicit request must be available here. A misconfigured
 * deployment (cloud without a public HTTPS URL) fails loudly rather than
 * silently stamping a transport it cannot serve.
 */
export const resolveTransport = (
  requested?: ChannelTransport,
): ChannelTransport => {
  const transport = requested ?? defaultTransport();
  if (!availableTransports().includes(transport)) {
    throw new ServiceError(
      "UNPROCESSABLE",
      transport === "socket"
        ? "Socket Mode isn't available on OneCLI Cloud — hosted workspaces connect over the Events API."
        : "Webhooks need a public HTTPS API URL. Set ONECLI_EXTERNAL_URL (or API_URL) to an https origin, or use Socket Mode.",
    );
  }
  return transport;
};
