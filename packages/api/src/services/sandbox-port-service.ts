import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "@onecli/db";
import {
  DESKTOP_CONTROL_PORT,
  DESKTOP_VIEW_PORT,
  MAX_PREVIEW_RELAUNCHES,
} from "@onecli/agent-protocol";
import { ServiceError } from "./errors";
import { PREVIEW_DOMAIN, PREVIEW_RELAY_SECRET } from "../lib/env";
import { previewsEnabled } from "../lib/preview-availability";
import { markSandboxEngaged } from "./due-work";
import { activeMembershipWhere } from "./organization-service";
import { isLiveReplica } from "./runner-replica-fence";
import { canAccessWorkspaceAsUser } from "./workspace-access-check";

/**
 * Sandbox ports, control-plane half (plans/sandbox-ports.md §4–§6).
 *
 * Owns the share rows (one per agent+port, stable slug → stable hostname),
 * the relay's resolution of a hostname, and the login handoff that proves a
 * browser belongs to a workspace member WITHOUT the preview domain ever
 * seeing a OneCLI session: the api signs a short-lived, host-bound ticket
 * with a secret it shares with the relay; the relay verifies it and sets its
 * own host-only cookie.
 *
 * Phase 1 serves `private` shares only. `link`/`public` rows are refused by
 * `resolveHost` until those phases land (fail-closed, not silently public).
 *
 * The api never dials a runner. A share or unshare changes rows only; the
 * runner re-arms its allowlist from those rows before opening a stream (and
 * on the relay's explicit refresh), and the relay re-checks every live
 * connection on its heartbeat, so revocation is enforced where the bytes
 * flow. That is the only shape that works when the api has no route to the
 * runner: the runner dials the control plane, never the reverse.
 */

export const MAX_PORTS_PER_AGENT = 5;
/** Live + revoked + reserved rows per agent (each port keeps one row). */
export const MAX_PORT_ROWS_PER_AGENT = 20;
/** Ports never shareable as a PREVIEW, whatever the caller asks (the
 * supervisor refuses 22 too). 22: SSH goes through the owner-only
 * terminator, never a preview. The hosted desktop's screen ports are the
 * platform's own share (kind "desktop"): a person must never mint a
 * preview onto the screen, and the desktop share never lists with, counts
 * against, or is revocable like, a preview. */
export const RESERVED_PORTS = new Set([
  22,
  DESKTOP_VIEW_PORT,
  DESKTOP_CONTROL_PORT,
]);
/** A share row's kind: what minted it and which surface owns it. */
export type SandboxPortKind = "preview" | "desktop";
/** A ticket only needs to survive one redirect. */
const TICKET_TTL_MS = 60_000;

const slugPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "agent";

/** Four random `[a-z0-9]` characters: enough to make a slug unguessable
 * without reading it, short enough to type. */
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomSuffix = () =>
  Array.from(
    { length: 4 },
    () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)],
  ).join("");

export const previewHostname = (slug: string) => `${slug}.${PREVIEW_DOMAIN}`;

/**
 * A desktop share's hostname label: `d-` so it reads apart from a
 * `p<port>-` preview at a glance, the control port marked `-ctl`, and the
 * same random suffix a preview gets. The agent id is not in it: the label
 * is what a person sees in a URL, and the preview's identifier-based label
 * is the pattern.
 */
export const desktopSlug = (agentIdentifier: string, port: number) =>
  `d-${slugPart(agentIdentifier)}-${randomSuffix()}${port === DESKTOP_CONTROL_PORT ? "-ctl" : ""}`;

const shareView = (row: {
  id: string;
  port: number;
  slug: string;
  visibility: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) => ({
  id: row.id,
  port: row.port,
  hostname: previewHostname(row.slug),
  url: `https://${previewHostname(row.slug)}`,
  visibility: row.visibility,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  active: row.revokedAt === null,
  createdAt: row.createdAt.toISOString(),
});
export type SandboxPortView = ReturnType<typeof shareView>;

const assertPreviewsEnabled = () => {
  // Dark, not broken: the ssh/runner posture. A deployment without a
  // (safe) preview domain has no ports surface at all.
  if (!previewsEnabled())
    throw new ServiceError(
      "NOT_FOUND",
      "Previews are not available on this deployment",
    );
};

const hostedAgentIn = async (workspaceId: string, agentId: string) => {
  assertPreviewsEnabled();
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      kind: true,
      identifier: true,
      sandbox: { select: { status: true, listeningPorts: true } },
    },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Ports are only available for hosted agents",
    );
  }
  return agent;
};

const assertShareablePort = (port: number) => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ServiceError("BAD_REQUEST", "port must be 1-65535");
  }
  if (RESERVED_PORTS.has(port)) {
    throw new ServiceError("UNPROCESSABLE", `Port ${port} can't be shared`);
  }
};

/**
 * The live, unexpired shared ports of a sandbox, for the runner that hosts
 * it — the ONLY source a runner arms its port allowlist from. Fenced to the
 * calling runner (`rnr_` identity): a runner learns nothing about sandboxes
 * it does not host. Dark deployments answer an empty list, so nothing is
 * ever dialable there.
 */
export const allowedPortsForRunner = async (
  runnerId: string,
  sandboxId: string,
): Promise<number[] | null> => {
  const sandbox = await db.sandbox.findFirst({
    where: { id: sandboxId, runnerId },
    select: { agentId: true },
  });
  if (!sandbox) return null;
  if (!previewsEnabled()) return [];
  const now = Date.now();
  // Every live private share, previews and the desktop's alike: the runner
  // arms what the control plane says, and the desktop ports are only
  // dialable because a desktop row says so.
  const rows = await db.sandboxPort.findMany({
    where: { agentId: sandbox.agentId, revokedAt: null, visibility: "private" },
    select: { port: true, expiresAt: true },
  });
  return rows
    .filter((p) => !p.expiresAt || p.expiresAt.getTime() > now)
    .map((p) => p.port)
    .filter((p) => p !== 22);
};

export const listSandboxPorts = async (
  workspaceId: string,
  agentId: string,
) => {
  const agent = await hostedAgentIn(workspaceId, agentId);
  const shares = await db.sandboxPort.findMany({
    where: { agentId: agent.id, kind: "preview" },
    orderBy: { port: "asc" },
  });
  // What the guest is listening on, as the supervisor last reported it (the
  // row is cleared whenever the box leaves `running`, so a parked agent
  // offers nothing to share).
  const listening =
    agent.sandbox?.status === "running" ? agent.sandbox.listeningPorts : [];
  return { shares: shares.map(shareView), listening };
};

/**
 * Share a port (idempotent). Re-sharing a revoked port revives the SAME row
 * — same slug, same hostname — so an app configured with the URL keeps
 * working across stop/start of the share.
 */
export const shareSandboxPort = async (input: {
  workspaceId: string;
  agentId: string;
  port: number;
  userId: string | null;
  approvalId?: string | null;
}): Promise<SandboxPortView> => {
  assertShareablePort(input.port);
  const agent = await hostedAgentIn(input.workspaceId, input.agentId);
  const existing = await db.sandboxPort.findUnique({
    where: { agentId_port: { agentId: agent.id, port: input.port } },
  });
  if (!existing || existing.revokedAt) {
    const live = await db.sandboxPort.count({
      where: { agentId: agent.id, revokedAt: null, kind: "preview" },
    });
    if (live >= MAX_PORTS_PER_AGENT) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `At most ${MAX_PORTS_PER_AGENT} shared ports per agent`,
      );
    }
  }
  const row = existing
    ? await db.sandboxPort.update({
        where: { id: existing.id },
        data: {
          revokedAt: null,
          visibility: "private",
          expiresAt: null,
          createdByUserId: input.userId ?? existing.createdByUserId,
          approvalId: input.approvalId ?? existing.approvalId,
        },
      })
    : await db.sandboxPort.create({
        data: {
          agentId: agent.id,
          port: input.port,
          slug: `p${input.port}-${slugPart(agent.identifier)}-${randomSuffix()}`,
          visibility: "private",
          createdByUserId: input.userId,
          approvalId: input.approvalId ?? null,
        },
      });
  return shareView(row);
};

/**
 * Reserve the hostname for a port WITHOUT sharing it: an inert, revoked row
 * (the relay refuses revoked rows; the allowlist ignores them). Lets an
 * agent's preview ask name its exact URL before a human approves it — the
 * approval then revives this same row.
 */
export const reserveSandboxPortSlug = async (
  agentId: string,
  port: number,
): Promise<string> => {
  assertShareablePort(port);
  const existing = await db.sandboxPort.findUnique({
    where: { agentId_port: { agentId, port } },
    select: { slug: true },
  });
  if (existing) return existing.slug;
  // Reservations are model-driven (one per asked port): bound them so an
  // agent looping over ports cannot grow rows without limit.
  const rows = await db.sandboxPort.count({
    where: { agentId, kind: "preview" },
  });
  if (rows >= MAX_PORT_ROWS_PER_AGENT) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `This agent has asked for too many different ports (max ${MAX_PORT_ROWS_PER_AGENT})`,
    );
  }
  const agent = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { identifier: true },
  });
  const row = await db.sandboxPort.upsert({
    where: { agentId_port: { agentId, port } },
    update: {},
    create: {
      agentId,
      port,
      slug: `p${port}-${slugPart(agent.identifier)}-${randomSuffix()}`,
      visibility: "private",
      revokedAt: new Date(),
    },
    select: { slug: true },
  });
  return row.slug;
};

/**
 * Preview traffic is activity: restart the sandbox's idle clock while a
 * person is looking at it (the SSH-session rule). Running sandboxes only,
 * so a preview hit can never resurrect a stopped box through this door
 * (waking is `/wake`'s explicit job), and only for a LIVE share, so a
 * revoked link stops keeping the box up.
 */
export const markPreviewActivity = async (agentId: string): Promise<void> => {
  const live = await db.sandboxPort.count({
    where: { agentId, revokedAt: null, kind: "preview" },
  });
  if (live === 0) return;
  await markSandboxEngaged(db, { agentId });
};

/**
 * The agent's relaunch command for one of its preview ports (the
 * `preview_expose` startCommand): what the supervisor runs for the viewer
 * when a preview hit wakes a sleeping sandbox. Fenced on the agent's own
 * row; the ask reserved it. Model text, stored verbatim and never
 * interpreted here: it runs inside the agent's own sandbox, as the agent's
 * own background process, which is nothing a `process_start` could not do.
 */
export const setPreviewStartCommand = async (
  agentId: string,
  port: number,
  startCommand: string,
): Promise<void> => {
  await db.sandboxPort.updateMany({
    where: { agentId, port, kind: "preview" },
    data: { startCommand },
  });
};

/**
 * The relaunch commands of the agent's live preview shares, in the start
 * payload's shape, for a wake a preview hit caused. Empty when nothing to
 * relaunch (no live share names a command).
 */
export const previewRelaunchesFor = async (
  agentId: string,
): Promise<{ port: number; command: string }[]> => {
  const rows = await db.sandboxPort.findMany({
    where: {
      agentId,
      kind: "preview",
      revokedAt: null,
      startCommand: { not: null },
    },
    select: { port: true, startCommand: true },
    orderBy: { port: "asc" },
    take: MAX_PREVIEW_RELAUNCHES,
  });
  return rows.flatMap((row) =>
    row.startCommand ? [{ port: row.port, command: row.startCommand }] : [],
  );
};

export const unshareSandboxPort = async (
  workspaceId: string,
  agentId: string,
  port: number,
) => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ServiceError("BAD_REQUEST", "port must be 1-65535");
  }
  const agent = await hostedAgentIn(workspaceId, agentId);
  const row = await db.sandboxPort.findUnique({
    where: { agentId_port: { agentId: agent.id, port } },
  });
  if (!row || row.kind !== "preview")
    throw new ServiceError("NOT_FOUND", "Port is not shared");
  if (!row.revokedAt) {
    await db.sandboxPort.update({
      where: { id: row.id },
      // The relaunch command goes with the share: a person who revoked the
      // link has withdrawn the standing permission to run that app for
      // viewers, and a later re-share starts clean until the agent
      // registers a command again (`previewRelaunchesFor` already ignores
      // revoked rows; this keeps the row honest for the re-share too).
      data: { revokedAt: new Date(), startCommand: null },
    });
  }
};

// ── relay surface ───────────────────────────────────────────────────────────

const HOST_LABEL = /^[a-z0-9-]{3,80}$/;

/**
 * What the relay needs to route one hostname, or null (404 page). A desktop
 * host carries two more facts, enforced on the wire: which of the screen's
 * two ports it names (`desktop.role`: "view" lets anyone the viewer check
 * admits watch; "control" lets exactly the current controller drive) and
 * who that controller is right now (null between takeovers, so a control
 * stream is refused the moment control is released or the lease lapses).
 */
export const resolveHost = async (host: string) => {
  const hostname = host.toLowerCase().split(":")[0] ?? "";
  const suffix = `.${PREVIEW_DOMAIN}`;
  if (!previewsEnabled() || !hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  if (!HOST_LABEL.test(slug)) return null;
  const row = await db.sandboxPort.findUnique({
    where: { slug },
    select: {
      port: true,
      kind: true,
      visibility: true,
      expiresAt: true,
      revokedAt: true,
      agent: {
        select: {
          id: true,
          name: true,
          workspaceId: true,
          sandbox: {
            select: {
              id: true,
              status: true,
              channelConnectionId: true,
              channelReplica: {
                select: { portApiUrl: true, lastSeenAt: true, retiredAt: true },
              },
            },
          },
          desktopSession: {
            select: { controllerUserId: true, controlExpiresAt: true },
          },
        },
      },
    },
  });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
    return { state: "expired" as const };
  // Phase 1: private only. Anything else is refused, never served public.
  if (row.visibility !== "private") return null;
  const sandbox = row.agent.sandbox;
  const base = {
    state: "ok" as const,
    agentId: row.agent.id,
    agentName: row.agent.name,
    workspaceId: row.agent.workspaceId,
    sandboxId: sandbox?.id ?? null,
    sandboxStatus: sandbox?.status ?? null,
    port: row.port,
    visibility: row.visibility,
    runnerPortApiUrl: sandbox ? holderPortApiUrl(sandbox) : null,
  };
  if (row.kind !== "desktop") return { ...base, kind: "preview" as const };
  const session = row.agent.desktopSession;
  const leaseLive =
    session?.controlExpiresAt !== null &&
    session?.controlExpiresAt !== undefined &&
    session.controlExpiresAt.getTime() > Date.now();
  return {
    ...base,
    kind: "desktop" as const,
    desktop: {
      role:
        row.port === DESKTOP_CONTROL_PORT
          ? ("control" as const)
          : ("view" as const),
      controllerUserId: leaseLive ? (session?.controllerUserId ?? null) : null,
    },
  };
};
export type ResolvedHost = NonNullable<Awaited<ReturnType<typeof resolveHost>>>;

/**
 * Where to open a preview stream: the port API of the runner copy holding
 * the sandbox's control socket, because the stream rides that socket and no
 * other copy has it. The same channel record routes the sandbox's turns.
 * Null while nothing can carry a stream: no socket held (booting, or the
 * supervisor is reconnecting), a holder that stopped heartbeating or is
 * shutting down (retired), or a copy that serves no port API. The relay then
 * shows its waking page and asks again.
 */
const holderPortApiUrl = (sandbox: {
  channelConnectionId: string | null;
  channelReplica: {
    portApiUrl: string | null;
    lastSeenAt: Date;
    retiredAt: Date | null;
  } | null;
}): string | null => {
  const holder = sandbox.channelReplica;
  if (sandbox.channelConnectionId === null || holder === null) return null;
  if (!isLiveReplica(holder)) return null;
  return holder.portApiUrl;
};

// ── login handoff tickets (api signs, relay verifies) ──────────────────────

// Domain-separated: the same secret is also the relay's bearer, so a
// signature is only ever over "preview-ticket\n" + body, never a bare value.
const sign = (payload: string) =>
  createHmac("sha256", PREVIEW_RELAY_SECRET)
    .update(`preview-ticket\n${payload}`)
    .digest("base64url");

/** `host.userId.expiresAtMs.sig` — base64url fields, host-bound. */
export const mintPreviewTicket = (
  host: string,
  userId: string,
  now = Date.now(),
) => {
  if (!PREVIEW_RELAY_SECRET)
    throw new ServiceError("UNPROCESSABLE", "Previews are not configured");
  const exp = now + TICKET_TTL_MS;
  const body = [
    Buffer.from(host).toString("base64url"),
    Buffer.from(userId).toString("base64url"),
    String(exp),
  ].join(".");
  return `${body}.${sign(body)}`;
};

export const verifyPreviewTicket = (
  ticket: string,
  host: string,
  now = Date.now(),
) => {
  if (!PREVIEW_RELAY_SECRET) return null;
  const parts = ticket.split(".");
  if (parts.length !== 4) return null;
  const [h, u, exp, sig] = parts as [string, string, string, string];
  const want = Buffer.from(sign(`${h}.${u}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Buffer.from(h, "base64url").toString() !== host) return null;
  if (!/^\d+$/.test(exp) || Number(exp) < now) return null;
  return { userId: Buffer.from(u, "base64url").toString() };
};

/**
 * May this signed-in user use this host? Workspace membership via the SAME
 * gate every workspace-scoped request uses (active org membership +
 * multi-org workspace binding), and for a desktop CONTROL host the lease
 * too: membership gets you the view, the live lease alone gets you the
 * input. Null reads as "no", whichever fence refused.
 */
export const authorizeHost = async (userId: string, host: string) => {
  const target = await resolveHost(host);
  if (!target || target.state !== "ok") return null;
  const workspace = await db.workspace.findFirst({
    where: {
      id: target.workspaceId,
      organization: { members: { some: { userId, ...activeMembershipWhere } } },
    },
    select: { id: true, organizationId: true },
  });
  if (!workspace) return null;
  if (!(await canAccessWorkspaceAsUser(userId, workspace))) return null;
  if (
    target.kind === "desktop" &&
    target.desktop.role === "control" &&
    target.desktop.controllerUserId !== userId
  ) {
    return null;
  }
  return target;
};

/** The login handoff's authorization: a PREVIEW host this user may see. A
 * desktop host is not a page and never gets a browser session. */
export const authorizePreview = async (userId: string, host: string) => {
  const target = await authorizeHost(userId, host);
  return target?.kind === "preview" ? target : null;
};

/** The relay's per-session re-check (ticket redemption, the viewer
 * refresh, a stream's periodic check): every fence above. */
export const userCanViewHost = async (userId: string, host: string) =>
  (await authorizeHost(userId, host)) !== null;
