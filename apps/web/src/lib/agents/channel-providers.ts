/**
 * The dashboard's channel-provider registry — the web twin of the api's
 * `services/channels/registry.ts` and the adapter's `providers.ts`.
 *
 * Everything the generic channel surfaces need from a provider is a member
 * here: its display (name, brand mark), and the two cards the agent's
 * Channels section mounts (the attached face and the attach/re-attach
 * face). The section, the agent rail's connected mark and the sidebar's
 * agent rows iterate presences and look the provider up by id; none of them
 * names a provider. A Teams module is a directory of components plus one
 * registry line below, and inherits the section, the marks and the connect
 * round-trip (`?connected=<provider>` / the `app-connected` message).
 *
 * The one thing that stays provider-specific ON PURPOSE is the org-level
 * setup card (`org/[orgId]/channels`): each provider's onboarding is its
 * own story and is mounted by that page per provider.
 */
import type { ComponentType } from "react";
import type {
  AgentChannelPresence,
  ChannelTransport,
} from "@/lib/api/channels";

export interface ChannelProviderDisplay {
  /** The platform's proper name ("Slack"). */
  name: string;
  /** The brand mark as served from /public. */
  iconSrc: string;
}

/** Props the section hands the ATTACHED face. */
export interface PresenceCardProps {
  agentId: string;
  agentName: string;
  presence: AgentChannelPresence;
  hasOrgCredentials: boolean;
}

/** Props the section hands the ATTACH face (fresh, resuming, or removed). */
export interface AttachCardProps {
  agentId: string;
  posture: { transport: ChannelTransport; available?: ChannelTransport[] };
  pendingTransport?: ChannelTransport;
  hasOrgCredentials: boolean;
  organizationId: string;
  viewerIsOrgAdmin: boolean;
  resuming: boolean;
  removed: boolean;
  identityName: string | null;
  /**
   * The removed presence's provider-side app id, so a re-attach face can
   * point at THAT app instead of walking the first-time setup again. Null
   * unless `removed`.
   */
  removedAppId: string | null;
}

export interface ChannelProviderUi extends ChannelProviderDisplay {
  id: string;
  PresenceCard: ComponentType<PresenceCardProps>;
  AttachCard: ComponentType<AttachCardProps>;
}

/**
 * "Connected" for the marks (rail, sidebar) draws the same line the section
 * draws for its attached face: `active` or `needs_attention`. A presence row
 * exists from the moment a guided attach is clicked (`pending_setup`) and
 * stays after the workspace removes the app (`disabled`), so bare existence
 * is NOT connection. A missing `status` (an older API during deploy skew)
 * reads as connected — never as "everything just disconnected".
 */
export const isPresenceConnected = (presence: { status?: string }): boolean =>
  presence.status !== "pending_setup" && presence.status !== "disabled";

/** The connected presences an agent holds, in registry order. */
export const connectedPresences = <
  T extends { provider: string; status?: string },
>(
  channels: readonly T[] | undefined,
): T[] => (channels ?? []).filter(isPresenceConnected);
