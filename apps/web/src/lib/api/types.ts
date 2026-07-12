export interface Agent {
  id: string;
  name: string;
  identifier: string;
  accessToken: string;
  isDefault: boolean;
  secretMode: string;
  createdAt: string;
  _count: { agentSecrets: number; agentAppConnections: number };
}

export interface CreatedAgent {
  id: string;
  name: string;
  identifier: string;
  createdAt: string;
}

export interface AgentGranularAccess {
  agentId: string;
  agentName: string;
  connectionId: string;
  provider: string;
  connectionLabel: string | null;
  policy: Record<string, unknown>;
}

export interface AgentConnection {
  appConnectionId: string;
  sessionPolicy: Record<string, unknown> | null;
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
}

export interface CreatedSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string | null;
  createdAt: string;
  preview: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  /** Custom rules only — app-permission rules omit the endpoint fields. */
  hostPattern?: string;
  pathPattern?: string | null;
  method?: string | null;
  action: string;
  enabled: boolean;
  agentId: string | null;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  scope: string | null;
  metadata: unknown;
  conditions: unknown;
  createdAt: string;
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

export type ConnectionAccessLevel = "full" | "assigned" | "none";

// Reverse view of agent↔connection access: an agent and whether it can use a
// given connection. "full" = all-mode agent (implicit access, read-only here);
// "assigned" = selective agent granted this connection; "none" = neither.
// `scoped` flags an assigned agent whose grant carries a granular session
// policy (managed on the agent side; shown read-only here).
export interface ConnectionAgentAccess {
  id: string;
  name: string;
  access: ConnectionAccessLevel;
  scoped: boolean;
}

// A project row as returned by the project CRUD routes (rename / create).
export interface Project {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: string;
}

// Project access bindings (the human sharing surface for a project). `role` is
// the management role on a user binding (step 13c): "owner" may manage the
// project, "member" is a plain use grant. `isOwner` flags the creator — a
// provenance display hint, distinct from the (transferable) management role.
export interface ProjectAccessUserRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: "owner" | "member";
  isOwner: boolean;
  createdAt: string;
}

export interface ProjectAccessGroupRow {
  id: string;
  groupId: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface ProjectAccessBindings {
  users: ProjectAccessUserRow[];
  groups: ProjectAccessGroupRow[];
}

// The shares to keep. Each user carries a management `role` (owner = may manage
// the project); groups carry no role in v1.
export interface SetProjectAccessInput {
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
}

export interface CreateAgentInput {
  name: string;
  identifier: string;
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

export interface CreateRuleInput {
  name: string;
  hostPattern: string;
  pathPattern?: string | null;
  method?: string | null;
  action: string;
  enabled?: boolean;
  agentId?: string | null;
  rateLimit?: number | null;
  rateLimitWindow?: string | null;
  conditions?: unknown[];
}

// `conditions: null` clears existing conditions on update.
export type UpdateRuleInput = Partial<Omit<CreateRuleInput, "conditions">> & {
  conditions?: unknown[] | null;
};

// ── Org directory (§3.5 contract: groups, agent groups, members, agents) ──

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

export interface AgentGroupRow {
  id: string;
  name: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupMemberRow {
  agentId: string;
  name: string;
  identifier: string;
  projectId: string;
  projectName: string | null;
  addedAt: string;
}

export interface OrgAgentRow {
  id: string;
  name: string;
  identifier: string;
  projectId: string;
  projectName: string | null;
  /** The project's bound humans (first 3) — "whose project" disambiguation. */
  projectPeople: { name: string | null; email: string }[];
  projectPeopleTotal: number;
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
