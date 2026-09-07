/**
 * Channels: external messaging surfaces (plans/hosted-agents-v2.md step 6).
 *
 * The platform layer is provider-neutral — these are THE unions the schema
 * comments, validations, services and routes all lean on. "slack" is the
 * first provider; a later one (WhatsApp, Teams) extends `CHANNEL_PROVIDER_IDS`
 * and adds a registry entry, and the `Record` keying makes forgetting the
 * entry a compile error.
 *
 * SERVER-ONLY: providers reach outbound fetch logic and decrypted
 * credentials. Client code gets its data from the channel endpoints.
 */

// Type-only (erased at runtime, so no import cycle): the outcome unions are
// the ingestion service's own — the doors' vocabulary, already neutral.
import type {
  GroupInviteOutcome,
  IngestOutcome,
} from "./channel-ingestion-service";

export const CHANNEL_PROVIDER_IDS = ["slack"] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDER_IDS)[number];

/**
 * How a presence's inbound events reach us. "events" = the provider calls our
 * public HTTPS routes (the one-click posture); "socket" = the channel adapter
 * holds an outbound connection (the no-ingress floor). Stamped on the
 * presence at create — the provider-side app config baked one or the other.
 */
export const CHANNEL_TRANSPORTS = ["events", "socket"] as const;
export type ChannelTransport = (typeof CHANNEL_TRANSPORTS)[number];

/**
 * Which app flavor a per-agent provider app WAS built as. "agent" = the
 * provider's native agent UX (Slack: `features.agent_view` + the sessions
 * work-status loader); "regular" = a plain bot. NEW apps are always "agent";
 * "regular" survives as a per-presence stamp for pre-existing apps — the
 * provider-side config baked the flavor in and (Slack) the agent flavor is
 * irreversible per app, so a regular presence stays regular until it is
 * detached and re-attached.
 */
export const CHANNEL_APP_MODES = ["agent", "regular"] as const;
export type ChannelAppMode = (typeof CHANNEL_APP_MODES)[number];

export const PRESENCE_STATUSES = [
  "pending_setup",
  "active",
  "disabled",
  "needs_attention",
] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const THREAD_LINK_KINDS = ["direct", "group"] as const;
export type ThreadLinkKind = (typeof THREAD_LINK_KINDS)[number];

export const USER_LINK_SOURCES = ["email", "manual"] as const;
export type UserLinkSource = (typeof USER_LINK_SOURCES)[number];

/** A provider tenant's identity (Slack: a workspace). */
export interface ChannelTenant {
  externalId: string;
  name: string | null;
}

/** The presence's own identity on the provider (Slack: the bot user). */
export interface PresenceIdentity {
  tenant: ChannelTenant;
  identityRef: string;
  /** The app's display handle, where the provider tells us (Slack: the bot's
   * `user`). Absent on arms that never learn it — surfaces fall back to the
   * external id. */
  identityName?: string | null;
}

/**
 * A validated org automation credential and the tenant it belongs to. Every
 * path that obtains one (paste validation, rotation) reports the tenant so
 * the caller can hold the law that a credential never quietly rebinds the
 * org to another workspace.
 */
export interface ValidatedIntegrationCredential {
  tenant: ChannelTenant;
  credentialsJson: string;
}

/**
 * One file a provider's message event referenced — the neutral shape the
 * interpreters normalize into and the ingest doors thread through. `url` is
 * the provider's authenticated download address (Slack: `url_private`);
 * `needsInfo` marks a metadata stub the provider must resolve before
 * fetching (Slack Connect's `check_file_info`).
 */
export interface ChannelFileRef {
  id: string;
  name: string | null;
  mimeType: string | null;
  size: number | null;
  url: string | null;
  needsInfo: boolean;
}

/** One fetch's outcome. `reason` is user-facing copy on the failed chip. */
export type ChannelAttachmentFetch =
  | { ok: true; name: string; mimeType: string; bytes: Buffer }
  | {
      ok: false;
      name: string;
      mimeType: string;
      sizeBytes: number;
      reason: string;
    };

/**
 * One inbound event's outcome, in neutral vocabulary — what the generic
 * ingest door (`routes/channel-adapter.ts`) maps onto the adapter wire.
 * `replyChannel`/`replyThreadTs`/`channel` are provider-opaque addresses
 * the provider's interpreter minted; the ingest/invite outcome unions are
 * the ingestion service's own (already provider-neutral).
 */
export type ChannelDispatchResult =
  | { kind: "ignored"; reason: string }
  | {
      kind: "message";
      call: { replyChannel: string; replyThreadTs: string | null };
      outcome: IngestOutcome;
    }
  | {
      kind: "invite";
      call: { channel: string };
      outcome: GroupInviteOutcome;
    };

/** The org settings page's shared-app posture — one view per org. */
export interface ChannelSharedAppView {
  /** ADVERTISE the shared app (the "Add to <provider>" door): the deployment
   * has it configured and is reachable over public HTTPS. */
  available: boolean;
  /** The install carries a credential that can mint agent apps — the org
   * needs no pasted automation credential. */
  canMintAgentApps: boolean;
  /** A NEW install would capture the agent-app minting grant. Until then the
   * shared app is onboarding-only, so setup leads with the credential paste. */
  installMintsAgentApps: boolean;
  /** This org's tenant install, when one exists — returned regardless of
   * `available`, so an install made from the provider's side stays visible
   * (and removable) even while the deployment isn't advertising the door. */
  installation: {
    tenant: ChannelTenant;
    botUserId: string | null;
    createdAt: Date;
  } | null;
}

/**
 * A provider's OPTIONAL deployment-owned shared app: one app per deployment,
 * installed per tenant with a consent click, powering onboarding and (when
 * the consent granted it) minting per-agent apps without a pasted automation
 * credential. Slack is the only implementation today; the generic services
 * and routes reach the whole lifecycle through this facet alone, so "has no
 * shared app" is the absence of the facet, never a provider-id comparison.
 */
export interface ChannelSharedApp {
  /** The deployment configured this provider's shared app (env present). */
  configured(): boolean;
  view(organizationId: string): Promise<ChannelSharedAppView>;
  /** Mint the consent URL. Side-effect free; the install lands on the
   * provider's OAuth callback, possibly days later. */
  startInstall(input: { organizationId: string; actorUserId: string }): {
    installUrl: string;
  };
  /** Exchange a code parked by a marketplace-side install and name the
   * tenant it belongs to — binding nothing yet (the informed-confirm step). */
  inspectInstallCode(input: {
    organizationId: string;
    actorUserId: string;
    code: string;
  }): Promise<{ team: ChannelTenant; claim: string }>;
  /** Bind an inspected claim to the caller's org. */
  confirmInstallFromClaim(input: {
    organizationId: string;
    actorUserId: string;
    claim: string;
  }): Promise<{ organizationId: string; teamId: string }>;
  /** The setup document a self-hosted operator creates THEIR shared app
   * from, or null when the deployment cannot serve one. */
  setupManifest(): unknown;
  /** Disconnect the org's install (provider-side best-effort, local delete
   * regardless). False = there was nothing to disconnect. */
  disconnectInstall(organizationId: string): Promise<boolean>;
  /** Does the org's install hold a credential that can mint agent apps? */
  canMintApps(organizationId: string): Promise<boolean>;
  /**
   * The managed-apps arm of rotate-on-use: run `fn` with the install's mint
   * credential. Answers null — WITHOUT having run `fn` — when there is no
   * usable install, so the caller falls through to the org's automation
   * credential. A refusal the provider recognizes as "this credential class
   * may not mint" (Slack: `invalid_manager_app`) is recorded on the install
   * and ALSO answers null — that refusal guarantees no app was created, so
   * the caller's fall-through re-run of `fn` is safe. Any other `fn` error
   * propagates: a timed-out-but-succeeded mint must never run twice.
   */
  tryMintWith<T>(input: {
    organizationId: string;
    fn: (accessToken: string, integrationId: string) => Promise<T>;
  }): Promise<{ result: T } | null>;
}

/**
 * What one provider contributes to the generic layer. Deliberately only the
 * hooks the generic services call today — the altitude rule: generalize the
 * vocabulary and the dispatch, never speculate on a second provider's needs.
 *
 * Every `credentialsJson` below is the DECRYPTED provider-opaque JSON string
 * (the generic services own encrypt/decrypt via `getCrypto()`); its shape is
 * the provider module's business alone.
 */
export interface ChannelProvider {
  id: ChannelProviderId;
  /** Human name for API-served copy ("Slack"). */
  displayName: string;

  /**
   * One raw inbound event → interpreted door call → outcome, for BOTH
   * transports: the provider's HTTP events route and the socket adapter's
   * ingest endpoint hand events here, so classification, the echo guard,
   * and the fences cannot drift between them. The event payload is
   * provider-opaque; `identityRef` is the presence's own identity (the echo
   * guard's input); idempotency by `eventId` runs control-plane-side.
   */
  dispatchInbound(input: {
    presenceId: string;
    identityRef: string | null;
    event: unknown;
    eventId: string;
  }): Promise<ChannelDispatchResult>;

  /**
   * The deployment-owned shared app, where the provider has one. Absent =
   * the provider has no such concept, and every caller degrades to the
   * pasted-credential arm (routes answer "no shared app" with the
   * provider's display name).
   */
  sharedApp?: ChannelSharedApp;

  /**
   * Validate a pasted org automation credential and normalize it into what we
   * store, identifying the tenant it belongs to. For Slack this ROTATES the
   * pasted config token — rotation both proves the token works and returns
   * `team_id`, and the pasted pair is single-use anyway.
   */
  connectIntegration(
    rawCredential: string,
  ): Promise<ValidatedIntegrationCredential>;

  /**
   * Refresh a stored integration credential when the provider expires it
   * (Slack: the 12h config-token pair). Returns the replacement JSON plus the
   * tenant the rotation named — the caller asserts it against the stored row,
   * so a swapped credential can never quietly rebind the org to another
   * workspace — or null when the stored one needs no rotation. Throwing means
   * the credential is dead and the integration must surface its
   * needs-attention state.
   */
  /**
   * `force` rotates regardless of remaining lifetime — the proactive sweep
   * uses it, because whether an UNUSED refresh token survives its access
   * token's expiry is undocumented (verified 2026-08-07), and designing on an
   * undocumented guarantee is how an idle org wakes up to a dead credential.
   */
  rotateIntegrationCredential(
    credentialsJson: string,
    options?: { force?: boolean },
  ): Promise<ValidatedIntegrationCredential | null>;

  /**
   * Create the per-agent app on the provider (the guided arm). `accessToken`
   * is a FRESH integration credential (the caller rotates first). Returns the
   * new app's identity + the credential JSON to store (client creds, signing
   * secret — no bot token yet) and the human-facing URLs the UI drives:
   * `installUrl` (events arm — the prefilled consent page) or `settingsUrl`
   * (socket arm — where the app-level token is generated).
   */
  createManagedPresence(input: {
    accessToken: string;
    agentName: string;
    transport: ChannelTransport;
    publicApiUrl: string | null;
    oauthState: string | null;
    /** The attaching member, for the app's About description. */
    owner?: { name: string | null; email: string } | null;
  }): Promise<{
    externalId: string;
    credentialsJson: string;
    installUrl: string | null;
    settingsUrl: string;
  }>;

  /**
   * The app's own handle on the provider (Slack: the bot's `user`), read with
   * a PRESENCE credential. Best-effort by contract: implementations MUST
   * answer `null` rather than throw when the credential is dead or the
   * provider is unreachable. Used to backfill presences that predate the
   * column; it does not correct a rename, since the backfill only ever writes
   * onto a presence with no name.
   */
  fetchIdentityName?(input: {
    credentialsJson: string | null;
  }): Promise<string | null>;

  /**
   * Verify pasted presence tokens (the socket arm's completion door and the
   * whole paste floor) and resolve the presence's identity. Merges into the
   * existing stored JSON when the guided create already holds client creds;
   * `transport` decides which pasted fields are mandatory (socket needs the
   * app-level token; a paste-floor events presence needs the signing secret
   * our inbound routes verify against).
   */
  completePresence(input: {
    pasted: Record<string, string>;
    existingCredentialsJson: string | null;
    transport: ChannelTransport;
  }): Promise<{ identity: PresenceIdentity; credentialsJson: string }>;

  /**
   * The events arm's completion door: exchange the OAuth code for the bot
   * token using the stored client credentials.
   */
  exchangeOAuthCode(input: {
    code: string;
    redirectUri: string;
    credentialsJson: string;
  }): Promise<{ identity: PresenceIdentity; credentialsJson: string }>;

  /**
   * Rename the remote app to a tombstone, so the record it leaves behind does
   * not squat a person's name. FIRST of the three teardown steps: an
   * uninstalled app can no longer be exported.
   *
   * ANSWERS WHETHER THE NAME LANDED, which the caller gates the delete on —
   * providers may apply a rename asynchronously, and deleting before it lands
   * freezes the agent's name onto the corpse forever. Answers `false` rather
   * than throwing.
   */
  renameRemotePresence?(input: {
    accessToken: string;
    externalId: string;
    /** The presence's own credential — the bot token this polls with. */
    credentialsJson: string | null;
    /** The bot user to watch (Slack: `U…`), from the presence row. */
    identityRef: string | null;
  }): Promise<boolean>;

  /**
   * Push the agent's CURRENT name onto the live remote app — the "agent was
   * renamed" sync, so the bot in the customer's workspace does not keep
   * answering to the old name. Fire-and-forget posture: the provider applies
   * it asynchronously and nobody gates on it; best-effort by contract.
   */
  syncRemotePresenceName?(input: {
    accessToken: string;
    externalId: string;
    name: string;
  }): Promise<void>;

  /**
   * The provider's own settings page for a live presence — where things the
   * provider exposes no API for (e.g. Slack's app PROFILE icon) are set by
   * hand. Pure URL construction from the presence's externalId; the web
   * renders a deep link wherever the projection carries it.
   */
  presenceSettingsUrl?(input: { externalId: string }): string;

  /**
   * Uninstall the app from the workspace, using the presence's OWN credentials.
   *
   * Separate from `deleteRemotePresence` because it needs no org config token:
   * an org that never connected one still gets the bot out of its workspace.
   *
   * Best-effort by contract: answer rather than throw when the credential is
   * dead, already uninstalled, or the provider is unreachable.
   */
  uninstallRemotePresence?(input: {
    credentialsJson: string | null;
  }): Promise<void>;

  /**
   * Best-effort remote app-record deletion at detach (guided orgs that asked).
   *
   * Runs with the ORG's config token, so it is skipped entirely for orgs that
   * have none. `uninstallRemotePresence` is the half that still runs for them.
   */
  deleteRemotePresence(input: {
    accessToken: string;
    externalId: string;
  }): Promise<void>;

  /**
   * The provider-verified email behind an external user id, for the lazy
   * account link — called by the ingestion fence only when no link exists.
   * Undefined (unknown user, no permission, no credential) just means "not
   * linkable automatically"; never throw for that.
   */
  lookupUserEmail(input: {
    credentialsJson: string | null;
    externalUserId: string;
  }): Promise<string | undefined>;

  /**
   * Fetch one user-attached file's bytes with the presence's own credential.
   * Per-file failures come back as `ok: false` outcomes, never throws — the
   * ingest door records them as byteless `failed` attachments so the chip
   * and the context note can say what happened. The provider owns every
   * transport rule: which hosts its credential may ever be sent to, redirect
   * policy, the stub-metadata follow-up (Slack Connect's `files.info`), and
   * the streamed byte cap.
   */
  fetchAttachment(input: {
    credentialsJson: string | null;
    file: ChannelFileRef;
    maxBytes: number;
  }): Promise<ChannelAttachmentFetch>;

  /**
   * The receipt-reaction pair: mark the user's message "seen" while its turn
   * runs, and take the mark off when the answer posts. `channel`/`messageTs`
   * are the provider-opaque message address the ingest door recorded; the
   * provider's idempotency refusals (already marked / already clear) must
   * resolve, not throw — the callers are detached best-effort tasks.
   */
  addReceiptReaction(input: {
    credentialsJson: string | null;
    channel: string;
    messageTs: string;
    reaction: string;
  }): Promise<void>;
  removeReceiptReaction(input: {
    credentialsJson: string | null;
    channel: string;
    messageTs: string;
    reaction: string;
  }): Promise<void>;

  /**
   * The provider's NATIVE thread work-status (Slack: the agent-session
   * "Working…" loader) — the ack an agent-flavor app shows in a group thread
   * instead of the receipt reaction. `working: true` turns it on when a turn
   * is accepted; `false` clears it when the answer posts. THROWS on refusal
   * (missing scope, plan-gated workspace, not an agent app): the caller's
   * fallback to the reaction receipt depends on hearing the failure — this is
   * the one receipt hook that must not swallow. Only meaningful for
   * agent-flavor presences in threads; absent = the provider has no native
   * work-status and reactions are all there is.
   */
  /**
   * NARRATE what the agent is doing, as a card beside the conversation —
   * one row per tool call, the newest running and the rest finished.
   *
   * Optional twice over: a provider that cannot narrate omits it entirely,
   * and one that can may still answer `null` for a workspace that refuses.
   * Either way the caller does nothing further and the native loader stands
   * — narration is decoration and must never be load-bearing.
   *
   * `activities` is the turn's WHOLE list, oldest first, because the card is
   * re-rendered rather than patched: there is no partial state to reconcile,
   * and a missed update is corrected by the next one.
   *
   * `cardTs` is the provider's handle for a card already posted, or null to
   * post the first one. The returned handle is persisted by the caller and
   * handed back next time.
   *
   * `threadTs` is where the card belongs when the conversation is threaded
   * (a channel mention); null means the conversation itself (a DM), where
   * the card sits inline rather than opening a thread nobody asked for.
   *
   * Every activity is UNTRUSTED (model-derived) and already bounded to one
   * short line by the shared derivation; a provider must not widen it.
   */
  narrateThreadWork?(input: {
    credentialsJson: string | null;
    channel: string;
    threadTs: string | null;
    activities: string[];
    cardTs: string | null;
  }): Promise<{ cardTs: string } | null>;

  /**
   * REMOVE the narration card, once the answer has been posted — the card is
   * a loader, not a reply, and leaving it behind would make every turn end
   * with two messages.
   *
   * Best-effort and idempotent: it runs on the clear path AND the stale
   * sweep, so it must tolerate a card that is already gone.
   */
  removeThreadNarration?(input: {
    credentialsJson: string | null;
    channel: string;
    cardTs: string;
  }): Promise<void>;

  setThreadWorkStatus?(input: {
    credentialsJson: string | null;
    /** The provider-opaque conversation id (Slack: channel id). */
    channel: string;
    /** The thread root the status is keyed by (Slack: `thread_ts`). */
    threadTs: string;
    working: boolean;
  }): Promise<void>;

  /**
   * REACH support - the space-grant lane ("may the agent answer everyone in
   * this channel?"), one facet like `sharedApp`: absence means the provider
   * has no space concept, space grants never match, and pending grants
   * surface in the dashboard alone. Everything here is provider-shaped on
   * purpose - the generic reach service never parses a provider address,
   * never calls the provider's user API, and never renders a card.
   */
  reach?: {
    /**
     * The SPACE behind a group-thread address (Slack: the channel id in
     * front of `:threadTs`) - the reach ledger's space key. Pure string
     * surgery on the provider's own thread format.
     */
    spaceOf(externalThreadId: string): string;

    /**
     * The space's display label (Slack: "#channel-name"), for cards and the
     * dashboard. Display only - matching stays on the id (names rename).
     * Best-effort by contract: null rather than throw.
     */
    spaceLabel(input: {
      credentialsJson: string | null;
      externalRef: string;
    }): Promise<string | null>;

    /**
     * A PERSON's display label (Slack: "@dana" / their display name), for
     * the card and the dashboard. The person analogue of `spaceLabel`, and
     * display-only for the same reason: matching stays on the provider's
     * stable user id, because people rename themselves.
     *
     * Optional: a provider with no person concept simply never grows a
     * person lane, and its rows fall back to the raw ref.
     */
    personLabel?(input: {
      credentialsJson: string | null;
      externalRef: string;
    }): Promise<string | null>;

    /**
     * Resolve a NON-platform speaker for the guest lane: their display name
     * (untrusted - the caller cleans, clamps, and frames it) and whether
     * they belong to the presence's own tenant (the v1 same-tenant fence:
     * a Slack Connect participant is refused even in a granted channel).
     * Null = cannot verify, and the caller fails closed.
     */
    resolveGuestSpeaker(input: {
      credentialsJson: string | null;
      externalUserId: string;
      tenantExternalId: string;
    }): Promise<{ displayName: string | null; sameTenant: boolean } | null>;

    /**
     * The owner-DM reach card - the PLATFORM-composed approval prompt for a
     * reach grant, posted with the presence's own credential. Template text
     * is the implementation's own; every dynamic field is escaped and
     * clamped there; the button values carry ONLY the opaque grant id (the
     * injection rule). `settle` rewrites a posted card with the outcome.
     */
    card: {
      post(input: {
        credentialsJson: string;
        recipientExternalUserId: string;
        grantId: string;
        agentName: string;
        subjectLabel: string;
        /** WHAT is being asked about. The card's question and its buttons
         * differ by kind: a space has three answers (everyone here / OneCLI
         * users only / nobody), a person has two (this person may talk to
         * me, or may not) - "members only" says nothing about one human.
         * Defaulted by the renderer so an older caller still posts a space
         * card. */
        subjectKind?: "space" | "external_user";
      }): Promise<{ channel: string; ts: string }>;
      settle(input: {
        credentialsJson: string;
        channel: string;
        ts: string;
        subjectLabel: string;
        outcome: string;
        decidedByName: string;
        subjectKind?: "space" | "external_user";
      }): Promise<void>;
    };
  };

  /**
   * The paste floor's step 0: the setup document the user recreates the app
   * from by hand (Slack: the manifest JSON). Provider-defined shape; the
   * generic layer serves it opaquely.
   */
  buildSetupMaterial(input: {
    agentName: string;
    transport: ChannelTransport;
    publicApiUrl: string | null;
  }): unknown;

  /**
   * Rebuild the human-facing setup URLs for a RESUMED pending attach (the
   * dialog was closed mid-flow) from the stored credential JSON. Provider-
   * owned because the URLs are provider-shaped — the consent URL must carry
   * the provider's full scope list, and only the provider knows it.
   */
  rebuildSetupUrls(input: {
    externalId: string;
    transport: ChannelTransport;
    /** The ROW's stamp — a pre-existing pending "regular" attach must mint a
     * consent URL granting exactly the scopes its remote manifest declared. */
    appMode: ChannelAppMode;
    credentialsJson: string | null;
    oauthState: string | null;
  }): { installUrl: string | null; settingsUrl: string };
}
