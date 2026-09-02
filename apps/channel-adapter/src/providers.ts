import type {
  AdapterDecisionResponse,
  AdapterIngestResponse,
  AdapterPresence,
} from "@onecli/agent-protocol";
import type { ApprovalCardUi } from "./approvals";
import type { MirrorPosts } from "./mirror";
import { slackAdapterProvider } from "./slack/adapter-provider";

/**
 * The provider boundary: everything channel-shaped that the orchestrator
 * (adapter.ts) needs, gathered behind one interface per provider. The
 * orchestrator resolves a presence's provider ONCE from the registry below
 * and never imports a provider module directly — credential shape, transport
 * dialing, outcome copy, decision rendering, mirror posts, and approval
 * cards all live behind this seam (Slack: slack/adapter-provider.ts).
 *
 * The registry is also the version-skew defense: the wire's provider id is a
 * string from the control plane's point of view, and a NEWER control plane
 * may feed a provider this build has no implementation for. An unknown id
 * resolves to null, and the orchestrator skips that presence loudly instead
 * of running half a runtime against it.
 */

/** What the orchestrator hands a provider's transport: raw events flow to
 * ingest, approval clicks flow to the decision round-trip, and a permanent
 * failure hands the connection's fate back to the reconcile loop. The
 * provider owns everything payload-shaped — by the time these fire, the
 * channel's envelope has been parsed down to neutral inputs. */
export interface ProviderTransportHandlers {
  /** A channel event (already acked transport-side where the channel
   * requires it — redelivery semantics are the provider's business). */
  onEvent: (input: { event: unknown; eventId: string }) => void;
  /** A human clicked an approval card's button. The click carries ONLY the
   * opaque approval id plus the clicker's channel-native user id — the
   * control plane authorizes the clicker; the fence is never channel-side. */
  onApprovalDecision: (input: {
    approvalId: string;
    decision: "approve" | "deny";
    clickerExternalUserId: string;
  }) => void;
  /** A human clicked a REACH card's button ("how should the agent handle
   * this channel?"). Same trust shape as the approval click: only the
   * opaque grant id + the clicker's channel-native id ride the wire, and
   * the control plane authorizes the clicker. The three settlements are
   * the card's three answers - open to everyone here, OneCLI users only,
   * or silent in this channel. */
  onReachDecision: (input: {
    grantId: string;
    decision: "approved" | "members_only" | "blocked";
    clickerExternalUserId: string;
  }) => void;
  /** The connection can never come back on its own (bad credential, feature
   * disabled). The owner decides what happens next. */
  onPermanentFailure: (reason: string) => void;
  onLog: (message: string, detail?: unknown) => void;
}

/** A live provider connection, opaque to the orchestrator. */
export interface ProviderTransport {
  close: () => void;
  isOpen: () => boolean;
}

/** One outcome answered provider-side: what the control plane's door said,
 * plus everything the provider needs to post about it. */
export interface ProviderOutcomeContext {
  credential: string;
  iconUrl?: string;
  outcome: AdapterIngestResponse;
  onLog: (message: string, detail?: unknown) => void;
}

/**
 * Everything one channel provider supplies. The orchestrator stays
 * channel-neutral by construction: it never sees a token's shape, a block
 * payload, or an escape rule — those are all behind these members.
 */
export interface ChannelAdapterProvider {
  /** Extract the posting credential from a presence (the credential's shape
   * inside `credentialsJson` is the provider's business; everyone else
   * treats the returned string as opaque). Null when absent or unparsable. */
  credentialOf: (presence: AdapterPresence) => string | null;
  /** Dial the provider's live connection for a socket-transport presence.
   * Null when the presence lacks what the transport needs (logged via the
   * handlers) — the reconcile loop retries on the next config change. */
  openTransport: (
    presence: AdapterPresence,
    handlers: ProviderTransportHandlers,
  ) => ProviderTransport | null;
  /** Post whatever the ingest outcome owes the channel (refusals, the busy
   * line). Never throws — post failures are logged and swallowed, because
   * the caller's retry loop must not re-ingest an already-answered event. */
  respondToOutcome: (input: ProviderOutcomeContext) => Promise<void>;
  /** The settled-card text for a decision's result, rendered channel-native
   * (escaping included — the decided-by name is user-controlled). */
  decisionSettledText: (input: {
    decision: "approve" | "deny";
    result: AdapterDecisionResponse;
  }) => string;
  /** The completion pass's rendering seam (mirror.ts stays general). */
  posts: MirrorPosts;
  /** The approvals manager's rendering seam (approvals.ts stays general). */
  cardUi: ApprovalCardUi;
}

/** Every provider this build ships. A new channel lands here in one line. */
export const CHANNEL_ADAPTER_PROVIDERS: Record<string, ChannelAdapterProvider> =
  {
    slack: slackAdapterProvider,
  };

/** Registry lookup — null for a provider this build does not know (the
 * version-skew arm; the caller skips the presence rather than crashing).
 * `Object.hasOwn`, not bracket access alone: the id is a WIRE string, and
 * bracket access walks the prototype chain — `"constructor"` would answer
 * a truthy non-provider (the same trap the api's registry documents). */
export const channelAdapterProviderFor = (
  id: string,
): ChannelAdapterProvider | null =>
  Object.hasOwn(CHANNEL_ADAPTER_PROVIDERS, id)
    ? CHANNEL_ADAPTER_PROVIDERS[id]!
    : null;
