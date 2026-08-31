import type { ChannelPresenceStatus } from "./channels";

export type AgentKind = "byo" | "hosted";

export interface AgentChannelRef {
  provider: string;
  /** The app's handle in the workspace (Slack: "donna"), where known. */
  identityName: string | null;
  externalId: string;
  /** The provider's settings page for this presence (where manual-only
   * things like Slack's app profile icon live), or null. Optional: an older
   * API answers without it. */
  settingsUrl?: string | null;
  /** Presence lifecycle — `pending_setup` until the install completes.
   * Optional: an older API answers without it, and absent must read as
   * connected (the pre-status behavior), never a crash. */
  status?: ChannelPresenceStatus;
}

export interface Agent {
  id: string;
  name: string;
  identifier: string;
  accessToken: string;
  /** "byo" (bring-your-own: laptops, CI) | "hosted" (a platform-run sandbox). */
  kind: AgentKind;
  createdAt: string;
  /** Attached channel presences (Slack apps). Deleting the agent removes them
   * from the workspace too, so the delete confirmation names them. */
  channels: AgentChannelRef[];
  /** Newest gateway request inside the list's bounded lookback window; null =
   * none in-window (never used OR quiet — `agentLastSeen` tells them apart). */
  lastSeenAt: string | null;
  /** The avatar's public (key-fenced) URL, or null for the default mark. */
  imageUrl?: string | null;
  /** Live background work is holding this agent's computer up right now
   * (step 13's held-awake signal, in agent vocabulary). Optional: an older
   * API answers without it, and absent must read as false, never a crash. */
  workingInBackground?: boolean;
}

export interface CreatedAgent {
  id: string;
  name: string;
  identifier: string;
  kind: AgentKind;
  harness: string | null;
  model: string | null;
  instructions: string | null;
  createdAt: string;
  /** LLM keys attached automatically at creation. Empty = the workspace has
   * no key yet, and the agent cannot run until one is added. */
  llmKeys: string[];
}

export interface AgentDetail {
  id: string;
  name: string;
  identifier: string;
  kind: AgentKind;
  /** Hosted only — the adapter running in the sandbox ("jcode"). */
  harness: string | null;
  /** Hosted only — the provider model string. */
  model: string | null;
  /** Hosted only — the per-agent brief. */
  instructions: string | null;
  createdAt: string;
  channels: AgentChannelRef[];
  /** Newest gateway request inside the server's bounded lookback window — the
   * Install page's verify signal. Null when the agent has none in-window. */
  recentRequestAt: string | null;
  /** The avatar's public (key-fenced) URL, or null for the default mark. */
  imageUrl?: string | null;
  /** Live background work is holding this agent's computer up right now
   * (step 13's held-awake signal). Optional for older APIs; absent = false. */
  workingInBackground?: boolean;
}

export interface DropboxFolder {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
}

export interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  valueSource: string;
  opRef: string | null;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  metadata: Record<string, unknown> | null;
  scope: string | null;
  createdAt: string;
  /** Latest injected upstream call failed with a status that indicts the key
   * itself (401/403 auth, 402 billing, 429 limits). Cleared once a newer call
   * lands with any other status. LLM keys only. */
  lastError: { status: number; at: string } | null;
}

export interface CreatedSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string | null;
  createdAt: string;
  preview: string;
  /** Agents this key was auto-attached to because they could reach no LLM key
   * at all (see the API's `llm-autoattach-service`). Empty is normal — every
   * agent already had one. */
  attachedAgents: string[];
}

export interface Connection {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  scopes: string[];
  scope: string | null;
  metadata: unknown;
  connectedAt: string;
}

// A workspace row as returned by the workspace CRUD routes (rename / create).
export interface Workspace {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: string;
}

// Workspace access bindings (the human sharing surface for a workspace). `role` is
// the management role on a user binding (step 13c): "owner" may manage the
// workspace, "member" is a plain use grant. `isOwner` flags the creator — a
// provenance display hint, distinct from the (transferable) management role.
export interface WorkspaceAccessUserRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: "owner" | "member";
  isOwner: boolean;
  createdAt: string;
}

export interface WorkspaceAccessGroupRow {
  id: string;
  groupId: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface WorkspaceAccessBindings {
  users: WorkspaceAccessUserRow[];
  groups: WorkspaceAccessGroupRow[];
}

// The shares to keep. Each user carries a management `role` (owner = may manage
// the workspace); groups carry no role in v1.
export interface SetWorkspaceAccessInput {
  users: { userId: string; role: "owner" | "member" }[];
  groupIds: string[];
}

export type SsoConnectionStatus = "pending" | "active" | "disabled";

// An org's SSO/IdP connection — the redacted API shape (the OIDC client
// secret never leaves the server).
export interface OrgSsoConnection {
  id: string;
  type: "saml" | "oidc";
  status: SsoConnectionStatus;
  displayName: string;
  cognitoProviderName: string;
  config: {
    metadataUrl?: string;
    metadataXml?: string;
    issuer?: string;
    clientId?: string;
    certExpiresAt?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SsoTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SsoTestResult {
  ok: boolean;
  checks: SsoTestCheck[];
}

export interface CreateSsoConnectionInput {
  type: "saml" | "oidc";
  displayName: string;
  metadataUrl?: string;
  metadataXml?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface UpdateSsoConnectionInput {
  displayName?: string;
  enabled?: boolean;
  metadataUrl?: string;
  metadataXml?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

// An org's claimed email domain. `verifiedAt` null = pending the DNS TXT
// check; the token is published in DNS, so it's safe to expose here.
export interface OrgDomain {
  id: string;
  domain: string;
  verificationToken: string;
  verifiedAt: string | null;
  createdAt: string;
}

// A bearer token for the org's /scim/v2 provisioning endpoint. Reads only
// ever carry metadata — the plaintext exists solely in the create response.
export interface ScimToken {
  id: string;
  label: string;
  lastUsedAt: string | null;
  createdAt: string;
}

// POST /v1/org/scim/tokens — `token` is shown once and never retrievable.
export interface CreatedScimToken extends ScimToken {
  token: string;
}

// Require-SSO enforcement state (GET/PATCH /v1/org/sso/enforcement).
export interface OrgSsoEnforcement {
  ssoRequired: boolean;
  hasActiveConnection: boolean;
  hasVerifiedDomain: boolean;
  canRequire: boolean;
  exemptMemberCount: number;
}

// PATCH /v1/org/members/:userId — exactly one change per request.
export type UpdateOrgMemberInput =
  | { status: "active" | "suspended" }
  | { ssoExempt: boolean };

/** A pending invitation, as the org's admins see it. */
export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  invitedByEmail: string;
  /** Serialized over the wire — the server sends ISO strings. */
  expiresAt: string;
  createdAt: string;
}

export interface CreateInvitationInput {
  email: string;
  role: "admin" | "member";
}

export interface OrgMemberRow {
  userId: string;
  status: string;
  ssoExempt: boolean;
  /** Present on status changes: what happened on the Cognito side. */
  revocation?: string;
}

export interface ResourceCounts {
  agents: number;
  apps: number;
  llms: number;
  secrets: number;
  /** How many of the workspace's agents are working in the background right
   * now (step 13's held-awake signal). Optional for older APIs; absent = 0. */
  agentsWorkingInBackground?: number;
}

export interface CreateAgentInput {
  name: string;
  identifier: string;
  /** Defaults to "byo" server-side. */
  kind?: AgentKind;
  /** Hosted only; server defaults it to "jcode". */
  harness?: string;
  /** Hosted only. */
  model?: string;
  /** Hosted only — the per-agent brief. */
  instructions?: string;
}

export interface CreateSecretInput {
  name: string;
  type: string;
  value?: string;
  valueSource?: "inline" | "onepassword";
  opRef?: string;
  opDisplay?: { vault: string; item: string; field: string };
  hostPattern: string;
  pathPattern?: string;
  injectionConfig?: unknown;
}

// ── Org directory (groups, members) ──

/** Cursor envelope shared by every directory-scale list. */
export interface DirectoryPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface DirectoryListParams {
  limit?: number;
  cursor?: string;
  q?: string;
}

export interface GroupRow {
  id: string;
  name: string;
  /** "scim" groups are IdP-managed — manual writes 409. */
  source: "manual" | "scim";
  externalId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberRow {
  userId: string;
  email: string;
  name: string | null;
  addedAt: string;
}

// Group→role mappings (step 15): map an IdP group to an org role, priority-ordered.
export interface RoleMappingRow {
  id: string;
  groupId: string;
  groupName: string;
  role: "admin" | "member";
  priority: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleMappingInput {
  groupId: string;
  role: "admin" | "member";
  priority?: number;
}

export interface UpdateRoleMappingInput {
  role: "admin" | "member";
  priority?: number;
}

export interface RoleMappingImpact {
  affectedCount: number;
}

export interface OrgMemberListRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  ssoExempt: boolean;
  joinedAt: string;
}

// ── Shared policy identity/condition shapes ──────────────────────────────────
// Used by the editor's PolicyRuleV2. Workspace rules target a specific agent or
// "any" (empty); org rules target directory identities (user / user-group).
// Conditions are body-contains.

export type ProjectionIdentity =
  | { type: "agent"; id: string }
  | { type: "user"; id: string }
  | { type: "group"; id: string };

export interface ProjectionCondition {
  target: string;
  operator: string;
  value: string;
}

// ── Editable policy rules (policy_rules_v2) ──────────────────────────────────
// The editor's data (GET /rules → PolicyRuleDto): rows carry an `id` (for
// PATCH/DELETE), `enabled`, and are single-scope. Targets can be
// app/connection/secret/network — the dialog authors all four (an app target
// with no tools is the "All connections" whole-app shape; specific connections
// become `connection` targets).
export type PolicyRuleTarget =
  | {
      kind: "app";
      provider: string;
      // Named tools → the exact tool fan-out; EMPTY → the whole app (its
      // catalog hosts — permit on allow / block on block).
      tools: string[];
      // "All connections at a level" injection scope; null = no injection.
      // Injection-only — never affects matching.
      connectionScope: "organization" | "workspace" | null;
    }
  // Injects the connection and matches its provider's app — narrowed to `tools`
  // when set, else the whole app (empty = today's whole-app behavior).
  | { kind: "connection"; connectionId: string; tools: string[] }
  | {
      kind: "secret";
      // Step 8: a specific `secretId`, OR a `secretScope` ("all secrets at a
      // level") — exactly one is set.
      secretId: string | null;
      secretScope: "organization" | "workspace" | null;
    }
  | {
      kind: "network";
      hostPattern: string;
      pathPattern: string | null;
      method: string | null;
    };

export type PolicyRuleSource =
  | "custom"
  | "app_permission"
  | "blocklist"
  | "default"
  // Injection-only rules materialized from the equipment model (step 8); the
  // editor hides them (managed via the agent access UI).
  | "equipment"
  // Attach-model grant stacks (step 2): compiled by the grants API; rendered
  // as labeled, revocable derived rows until the workspace rules table retires.
  | "grant";

export interface PolicyRuleV2 {
  id: string;
  scope: "organization" | "workspace";
  status: "draft" | "published";
  generation: number;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  /** Generation-stable identity — the key for diffing draft vs published
   * (the row `id` regenerates on every publish). Empty on a virtual default. */
  logicalId: string;
  source: PolicyRuleSource;
  name: string;
  description: string | null;
  action: "allow" | "block";
  rateLimit: number | null;
  rateLimitWindow: "minute" | "hour" | "day" | null;
  requireApproval: boolean;
  conditions: ProjectionCondition[] | null;
  identities: ProjectionIdentity[];
  targets: PolicyRuleTarget[];
  createdAt: string;
}

export interface PublishResult {
  generation: number;
  ruleCount: number;
}

/** The scope's most recent publish. `appliedBy` null = a system publish (the
 * boot seeder); a null response = never published. */
export interface LastPublish {
  generation: number;
  ruleCount: number;
  appliedAt: string;
  appliedBy: { name: string | null; email: string } | null;
}

// ── Attach-model grants (plans/project-attach-model.md, step 2) ─────────────
// Hand-mirrored from packages/api/src/services/grants-service.ts and
// grants-summary-service.ts.

/** A grant's session policy ("Resources"): which repositories/folders the
 * connection's injected credential may reach. One strict axis per provider. */
export type GrantResources = { repositories: string[] } | { folders: string[] };

export interface AgentGrantConnection {
  connectionId: string;
  provider: string;
  label: string | null;
  scope: "workspace" | "organization";
  access: "full" | "custom";
  allow: string[];
  ask: string[];
  /** Null = unrestricted. */
  resources: GrantResources | null;
}

export interface AgentGrantSecret {
  secretId: string;
  name: string;
  type: string;
  scope: "workspace" | "organization";
}

export interface AgentGrants {
  agentId: string;
  /** "all" = the agent still injects the whole fenced pool (pre-flip). */
  mode: "all" | "grants";
  connections: AgentGrantConnection[];
  secrets: AgentGrantSecret[];
}

export interface ConnectionGrants {
  connectionId: string;
  agents: {
    agentId: string;
    access: "full" | "custom";
    allow: string[];
    ask: string[];
  }[];
}

/** `resources` is tri-state: ABSENT = preserve what the stack carries, NULL =
 * clear, OBJECT = set (server-validated per provider + edition). */
export type ConnectionGrantInput =
  | { access: "full"; resources?: GrantResources | null }
  | {
      access: "custom";
      allow: string[];
      ask: string[];
      resources?: GrantResources | null;
    };

export type GrantsSummaryEntry =
  | {
      kind: "app";
      provider: string;
      connectionId: string;
      label: string | null;
    }
  | { kind: "secret" | "llm"; id: string; name: string };

export interface AgentGrantsSummary {
  mode: "all" | "grants";
  entries: GrantsSummaryEntry[];
  total: number;
}

export interface AgentWithGrantsSummary extends Agent {
  grantsSummary: AgentGrantsSummary;
}

/** The current organization (`GET /v1/org`). `byoLegacy` is the org's
 * creation world on cloud (sandbox-platform §3.10, re-decided 2026-08-23):
 * false = hosted-first creation, true = BYO-only creation (hosted starts with
 * an onboarding call). `byoEnabled` (the mixed world, 2026-08-29) is only
 * read when `byoLegacy` is false: it additionally allows BYO creation beside
 * the hosted default — the gradual-migration path. Both operated manually per
 * org; inert on self-host, where the web never fetches them. */
export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  byoLegacy: boolean;
  byoEnabled: boolean;
}

/** Runtime instance metadata (`GET /v1/instance`) — the browser's only
 * source of truth for edition + enterprise entitlement (runtime env the baked
 * client bundle cannot see). */
export interface InstanceInfo {
  edition: "cloud" | "onprem";
  entitled: boolean;
  version: string;
  /**
   * Hosted-agents availability (§3.13). Two booleans, never runner identity:
   * `registered` gates the entrance — a deployment that never had a runner
   * shows no hosted surface at all — and `online` is what lets those surfaces
   * say "offline" instead of hiding agents that already exist.
   *
   * Optional because an older API answers without it, and "absent" must read
   * as "no hosted agents here", never as a crash.
   */
  runners?: {
    registered: boolean;
    online: boolean;
    /**
     * How the online runner keeps agent files (§3.9): `snapshot` archives
     * them to durable storage on sleep, `resident` keeps them on local disk.
     * Absent on an older API or while nothing is online. Posture, not data.
     */
    homeDurability?: "resident" | "snapshot";
  };
  /**
   * The SSH front door (sandbox-platform step 5): present only when this
   * deployment can mint certificates and terminate SSH. Same optional-field
   * contract as `runners`: absent (an older API, or a deployment without the
   * front door) means "no SSH here" — the rail auto-hides the agent's SSH
   * section off it — never a crash and never a teased dead door.
   */
  ssh?: {
    host: string;
    /** Public SSH port. Optional: an older API answers without it (assume
     *  22). Cloud is 22 (the NLB); self-host a high port. */
    port?: number;
  };
}

/**
 * A registered SSH public key (`/v1/user/ssh-keys`) — account-level, not
 * workspace-scoped: the same key authenticates its owner to every agent they
 * can reach. Public material only; a row grants nothing by itself.
 */
export interface SshKey {
  id: string;
  name: string;
  /** OpenSSH SHA256 fingerprint ("SHA256:..."), computed server-side. */
  fingerprint: string;
  createdAt: string;
  /** ISO timestamp of the last certificate minted from this key, or null. */
  lastUsedAt: string | null;
}

/**
 * Exactly one certificate source: a registered key's id (the one-click
 * path), or a pasted public key line (the API contract the future CLI
 * rides). The server refuses a body carrying both.
 */
export type MintSshCertificateSource =
  | { sshKeyId: string }
  | { publicKey: string };

/**
 * A freshly minted OpenSSH user certificate
 * (`POST /v1/agents/:agentId/ssh-certificate`). One-time material: nothing
 * caches it, and the matching private key never leaves the user's machine.
 */
export interface MintedSshCertificate {
  /** The full certificate line, ready to be written beside the private key
   *  as `<key>-cert.pub`. */
  certificate: string;
  /** The public SSH endpoint to connect to. */
  host: string;
  /** Public SSH port. Optional: an older API answers without it (assume 22,
   *  the connect command omits `-p`). */
  port?: number;
  /** The SSH username — the immutable agent id, the cert's principal. */
  user: string;
  serial: string;
  /** ISO timestamp. Gates NEW authentications only: an open session is not
   *  cut off when the certificate expires. */
  expiresAt: string;
}

// ── Conversations (plans/hosted-agents-v2.md step 4) ────────────────────────

export type ConversationSource = "web" | "slack" | "cron" | "watch";

export interface Conversation {
  id: string;
  agentId: string;
  source: ConversationSource;
  externalRef: string | null;
  /** The agent's one canonical thread (§3.18) — at most one per agent,
   *  materialized only by the get-or-create door. */
  direct: boolean;
  /** The owner of a direct thread (threads are per-user since the step-6
   *  pivot); null on group/source conversations, which have no single owner. */
  userId: string | null;
  /** Taken from the message that opened it; null until one arrives. Direct
   *  threads stay untitled — the agent is the name. */
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** At most one of `queued`/`dispatched`/`running` is live per conversation.
 * `joining`/`joined` are mid-run follow-ups: a message sent while a turn was
 * active, steering into it (`joining`) or confirmed consumed by it
 * (`joined`) — never "active", they coexist with the turn they ride. */
export type TurnStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "done"
  | "failed"
  | "aborted"
  | "joining"
  | "joined";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

/** OUR effort scale — the harness adapter translates it (§3.5). */
export type AgentEffort = "low" | "medium" | "high" | "max";

export interface ModelOption {
  id: string;
  label: string;
  /** "pinned" = a fallback list, because the live fetch could not be made. */
  source: "live" | "pinned";
}

/**
 * Everything the agent's Models section needs, in one call: which provider its
 * granted key names, what that provider can run, and what it runs now.
 *
 * `provider: null` is a normal answer, not an error — it means no LLM key is
 * granted yet, and it is what drives the "connect a key" state.
 */
export interface AgentModels {
  provider: string | null;
  providerLabel: string | null;
  providerScope: string | null;
  models: ModelOption[];
  efforts: { id: AgentEffort; label: string }[];
  defaults: { model: string; effort: AgentEffort | null };
  selected: { model: string; effort: AgentEffort | null; overridden: boolean };
  /** The list is pinned or stale rather than freshly fetched. */
  degraded: boolean;
}

/**
 * One attachment's renderable metadata — mirrors the server's
 * attachmentMetaSelect; bytes never ride a turn payload (they come from the
 * authenticated blob endpoint).
 */
export interface AttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** "pending" | "bound" | "failed" — a failed row renders the honest chip. */
  status: string;
}

export interface Turn {
  id: string;
  conversationId: string;
  status: TurnStatus;
  /** The door the message came through ("web", "slack", …) — what the origin
   *  chip renders. A string, not `ConversationSource`: a mirrored turn keeps
   *  its own door even inside a conversation another door opened. */
  source: string;
  /** The speaker; null when no platform user is behind the message (an
   *  unlinked channel sender). */
  userId: string | null;
  message: string;
  error: string | null;
  /**
   * A machine-readable reason beside `error`, set only when the UI must do
   * more than print the sentence: `"no_model_key"` / `"model_provider_error"`
   * attach the Models-page fix link, and the lifecycle codes render as a
   * quiet notice instead of the red box — none of which can be decided by
   * matching on prose. The full vocabulary is TURN_ERROR_CODES in
   * @onecli/api's conversation validations.
   */
  errorCode: string | null;
  usage: TurnUsage | null;
  /** The turn a mid-run follow-up targeted (kept after promotion as
   *  provenance) — what the thread groups a `joining`/`joined` bubble by. */
  followUpOfTurnId: string | null;
  /** Files the message carried — chips render from this; bytes come from the
   *  authenticated blob endpoint. */
  attachments: AttachmentMeta[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * Durable transcript kinds. `text.delta` is deliberately absent: it streams
 * and vanishes (the delta law), and the whole answer arrives once as `text`.
 */
export type TurnEventKind =
  | "notice"
  | "turn.started"
  | "text"
  | "tool.started"
  | "tool.finished"
  | "approval.pending"
  | "turn.done"
  | "error";

export interface TurnEvent {
  seq: number;
  turnId: string;
  type: TurnEventKind | "text.delta" | "thinking.delta";
  payload: Record<string, unknown>;
}

export interface TranscriptPage {
  events: TurnEvent[];
  /** The highest `seq` in this page — the cursor for the next one. */
  nextSince: number;
  hasMore: boolean;
}

/**
 * `POST /v1/turns/:id/abort` — a queued turn is abandoned outright
 * (`aborted: true`), an in-flight one has the abort delivered for the agent
 * to wind down (`delivered: true`); the terminal state then arrives like any
 * other turn update.
 */
export interface AbortTurnResult {
  aborted: boolean;
  delivered: boolean;
}

/**
 * `POST /v1/conversations/:id/messages` — say something whatever the agent
 * is doing. A free conversation answers `turn` (an ordinary turn was
 * created); a busy one answers `followUp` (the message rides its own row,
 * steering into the live turn or running next).
 */
export interface SendMessageOutcome {
  kind: "turn" | "followUp";
  turn: Turn;
}
