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
    credentialsJson: string | null;
    oauthState: string | null;
  }): { installUrl: string | null; settingsUrl: string };
}
