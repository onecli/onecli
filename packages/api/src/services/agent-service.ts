import { randomBytes } from "crypto";
import { db, Prisma } from "@onecli/db";
import type { AgentEffort } from "@onecli/agent-protocol";
import { ServiceError } from "./errors";
import { agentImageUrlOrNull } from "./agent-image-service";
import { LAST_SEEN_WINDOW_MS } from "../lib/agent-activity";
import { agentIdsWithLiveBackgroundWork, signalWork } from "./due-work";
import { pickRunnerForSandbox } from "./placement";
import { requestSandboxRespawn } from "./sandbox-service";
import { bumpHomeForAgent } from "./home-sync-service";
import { resolveAgentLlmCredential } from "./llm-credential-service";
import {
  teardownAgentPresences,
  syncAgentPresenceNames,
} from "./channels/agent-channel-service";
import { presenceSettingsUrlFor } from "./channels/registry";
import { autoAttachLlmKeys } from "./llm-autoattach-service";
import { llmProvider } from "../llm/registry";
import { isOnpremEdition } from "../lib/policy-flags";
import {
  IDENTIFIER_REGEX,
  INSTRUCTIONS_MAX_LENGTH,
  type AgentKind,
} from "../validations/agent";

export const generateAccessToken = () =>
  `aoc_${randomBytes(32).toString("hex")}`;

export interface CreateAgentInput {
  name: string;
  identifier: string;
  /** Defaults to "byo" — today's bring-your-own agents. */
  kind?: AgentKind;
  /** Hosted only. Defaults to "jcode" for hosted agents (§3.5 seam). */
  harness?: string;
  /** Hosted only — the per-agent brief (§3.11). */
  instructions?: string;
}

export const listAgents = async (workspaceId: string) => {
  const [agents, lastSeenRows, backgroundBusy] = await Promise.all([
    db.agent.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        identifier: true,
        accessToken: true,
        kind: true,
        imageKey: true,
        createdAt: true,
        // The delete confirmation names what leaves the customer's home
        // with the agent (its Slack app), so the list carries it — with
        // `status`, so the connected marks can tell a live install from a
        // clicked-but-unfinished `pending_setup` one.
        channels: {
          select: {
            provider: true,
            identityName: true,
            externalId: true,
            status: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    // Newest gateway request per agent, bounded to the last-seen window (a
    // range scan on the (workspace_id, created_at) index — never a walk of the
    // workspace's whole log history). Null = no request in-window; the client
    // tells "never used" from "quiet" via agentLastSeen.
    db.requestLog.groupBy({
      by: ["agentId"],
      where: {
        workspaceId,
        createdAt: { gte: new Date(Date.now() - LAST_SEEN_WINDOW_MS) },
      },
      _max: { createdAt: true },
    }),
    // The held-awake signal (step 13): which agents hold a box up with live
    // background work right now. One grouped query in due-work — the same
    // predicate the idle-stop claim enforces, so the signal cannot drift.
    agentIdsWithLiveBackgroundWork(workspaceId),
  ]);

  const lastSeenByAgent = new Map(
    lastSeenRows.map((r) => [r.agentId, r._max.createdAt]),
  );

  return agents.map(({ imageKey, ...a }) => ({
    ...a,
    channels: a.channels.map((c) => ({
      ...c,
      settingsUrl: presenceSettingsUrlFor(c.provider, c.externalId),
    })),
    imageUrl: agentImageUrlOrNull(a.id, imageKey),
    lastSeenAt: lastSeenByAgent.get(a.id) ?? null,
    workingInBackground: backgroundBusy.has(a.id),
  }));
};

/** Lookback for `recentRequestAt`: bounded so the RequestLog probe rides the
 * (workspace_id, created_at) index — unbounded, a zero-request agent would walk
 * the workspace's whole log history, and the Install page polls this read while
 * waiting for the agent's first request. */
export const RECENT_REQUEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const getAgentDetail = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      name: true,
      identifier: true,
      kind: true,
      harness: true,
      model: true,
      instructions: true,
      imageKey: true,
      createdAt: true,
      channels: {
        select: {
          provider: true,
          identityName: true,
          externalId: true,
          status: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const [recent, backgroundBusy] = await Promise.all([
    db.requestLog.findFirst({
      where: {
        workspaceId,
        agentId,
        createdAt: { gte: new Date(Date.now() - RECENT_REQUEST_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    agentIdsWithLiveBackgroundWork(workspaceId),
  ]);

  const { imageKey, ...agentRest } = agent;
  return {
    ...agentRest,
    channels: agent.channels.map((c) => ({
      ...c,
      settingsUrl: presenceSettingsUrlFor(c.provider, c.externalId),
    })),
    imageUrl: agentImageUrlOrNull(agent.id, imageKey),
    recentRequestAt: recent?.createdAt ?? null,
    workingInBackground: backgroundBusy.has(agentId),
  };
};

export const agentExistsByIdentifier = async (
  workspaceId: string,
  identifier: string,
): Promise<boolean> => {
  const existing = await db.agent.findFirst({
    where: { workspaceId, identifier: identifier.trim() },
    select: { id: true },
  });
  return existing !== null;
};

export const createAgent = async (
  workspaceId: string,
  input: CreateAgentInput,
  /** Who to record as the grantor of the auto-attached LLM keys. */
  userId: string | null = null,
) => {
  const trimmed = input.name.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Name must be between 1 and 255 characters",
    );
  }

  const trimmedIdentifier = input.identifier.trim();
  if (!IDENTIFIER_REGEX.test(trimmedIdentifier)) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Identifier must be 1-50 characters, start with a letter or number, and contain only lowercase letters, numbers, and hyphens",
    );
  }

  // Re-validated here (not only in zod) so the service holds its own
  // invariants — the /v1 route is the only production caller today, but
  // nothing forces the next caller through zod.
  const kind: AgentKind = input.kind ?? "byo";
  const hosted = kind === "hosted";
  if (!hosted && (input.harness || input.instructions)) {
    throw new ServiceError(
      "BAD_REQUEST",
      "harness and instructions are only valid for hosted agents",
    );
  }
  if (
    input.instructions !== undefined &&
    input.instructions.length > INSTRUCTIONS_MAX_LENGTH
  ) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Instructions must be at most ${INSTRUCTIONS_MAX_LENGTH} characters`,
    );
  }

  const existing = await db.agent.findFirst({
    where: { workspaceId, identifier: trimmedIdentifier },
    select: { id: true },
  });
  if (existing) {
    throw new ServiceError(
      "CONFLICT",
      "An agent with this identifier already exists",
    );
  }

  // Cloud creation worlds (sandbox-platform §3.10 as re-decided 2026-08-23,
  // mixed world added 2026-08-29): the org's byoLegacy column picks the
  // creation door — false means hosted-first (BYO additionally allowed when
  // byoEnabled is set: the gradual-migration world), true means BYO-only
  // (hosted starts with an onboarding call; byoEnabled is never consulted).
  // Self-host is ungated. Placed after the identifier check so a re-created
  // identifier still answers 409 (SDK ensureAgent stays idempotent), and read
  // at call time so tests can pin either edition per case.
  if (!isOnpremEdition()) {
    const ws = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        organization: { select: { byoLegacy: true, byoEnabled: true } },
      },
    });
    if (!ws) {
      throw new ServiceError("NOT_FOUND", "Workspace not found");
    }
    if (
      kind === "byo" &&
      !ws.organization.byoLegacy &&
      !ws.organization.byoEnabled
    ) {
      throw new ServiceError(
        "FORBIDDEN",
        "BYO agent creation isn't enabled for this organization. Create a hosted agent instead.",
      );
    }
    if (kind === "hosted" && ws.organization.byoLegacy) {
      throw new ServiceError(
        "FORBIDDEN",
        "Hosted agents for this organization start with an onboarding call. Book one at https://cal.com/onecli/15min.",
      );
    }
  }

  const accessToken = generateAccessToken();

  // A hosted agent needs a computer, so it needs a runner to host it. Placed
  // here rather than at first use so "created" never means "created but can
  // never run" (§3.17: placement is a seam — today it picks the instance's
  // one runner).
  const runnerId = hosted ? await pickRunnerForSandbox() : null;
  if (hosted && !runnerId) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "No runner is available to host this agent. Start a runner and try again.",
    );
  }

  try {
    const agent = await db.agent.create({
      data: {
        name: trimmed,
        identifier: trimmedIdentifier,
        accessToken,
        workspaceId,
        // Explicit even though it is the schema default — the house convention
        // at every creation site, so a future default flip changes nothing here.
        kind,
        // One harness today; the column is the seam (§3.5).
        harness: hosted ? (input.harness ?? "jcode") : null,
        instructions: hosted ? input.instructions?.trim() || null : null,
        // The computer record is born with the agent, unprovisioned: the next
        // runner poll finds it due and starts it (§3.3 — poll time is the
        // clock, no background loop).
        ...(runnerId && {
          sandbox: { create: { runnerId, status: "unprovisioned" } },
        }),
      },
      select: {
        id: true,
        name: true,
        identifier: true,
        kind: true,
        harness: true,
        model: true,
        instructions: true,
        createdAt: true,
      },
    });

    // Wake any held runner poll so the sandbox starts now rather than after
    // the next re-check.
    if (hosted) signalWork();

    // Equip it before anyone can use it. This lives in the SERVICE, not the
    // route, so "an agent that can never run" stays impossible for any caller
    // of createAgent, not just the /v1 route. Best-effort by contract — see
    // `llm-autoattach-service`.
    const { secretIds } = await autoAttachLlmKeys(
      workspaceId,
      agent.id,
      userId,
    ).catch(() => ({ secretIds: [] as string[] }));

    // `llmKeys` is part of the create contract: an empty array means the
    // workspace has no LLM key, which is the one thing a caller must be able
    // to react to (the dashboard turns it into a guided "add one now").
    return { ...agent, llmKeys: secretIds };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "An agent with this identifier already exists",
      );
    }
    throw err;
  }
};

export const deleteAgent = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, workspace: { select: { organizationId: true } } },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  // Channel presences hold state OUTSIDE our database — a Slack app installed
  // in the customer's home and a service API key. The row cascade would
  // drop our end and leave both alive, so tear them down first. Best-effort
  // inside: a provider that refuses must not make the agent undeletable.
  await teardownAgentPresences({
    id: agent.id,
    organizationId: agent.workspace.organizationId,
  });

  // Every agent is deletable, the last one included: a workspace with no agents
  // is a valid state (nothing is seeded), and the old "cannot delete the
  // default agent" guard made the first agent permanent.
  await db.agent.delete({ where: { id: agentId } });
};

export interface UpdateAgentInput {
  name?: string;
  /** The brief (§3.11). Null clears it. kind/harness are immutable. */
  instructions?: string | null;
  /**
   * The model/effort OVERRIDE (§3.10). Null clears it, restoring the granted
   * provider's default. `modelProvider` is absent on purpose — the service
   * stamps it, so a caller cannot write the pair half-set.
   */
  model?: string | null;
  effort?: AgentEffort | null;
}

export const updateAgent = async (
  workspaceId: string,
  agentId: string,
  patch: UpdateAgentInput,
) => {
  const data: {
    name?: string;
    instructions?: string | null;
    model?: string | null;
    effort?: string | null;
    modelProvider?: string | null;
  } = {};

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed || trimmed.length > 255) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Name must be between 1 and 255 characters",
      );
    }
    data.name = trimmed;
  }

  if (patch.instructions !== undefined) {
    if (
      patch.instructions !== null &&
      patch.instructions.length > INSTRUCTIONS_MAX_LENGTH
    ) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Instructions must be at most ${INSTRUCTIONS_MAX_LENGTH} characters`,
      );
    }
    // Empty string and null both clear the brief.
    data.instructions = patch.instructions?.trim() || null;
  }

  const changingModel = patch.model !== undefined || patch.effort !== undefined;

  if (Object.keys(data).length === 0 && !changingModel) {
    throw new ServiceError(
      "BAD_REQUEST",
      "At least one field to update is required",
    );
  }

  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      kind: true,
      workspaceId: true,
      name: true,
      instructions: true,
      model: true,
      effort: true,
      modelProvider: true,
      workspace: { select: { organizationId: true } },
    },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (
    (data.instructions !== undefined || changingModel) &&
    agent.kind !== "hosted"
  ) {
    throw new ServiceError(
      "BAD_REQUEST",
      "instructions, model and effort are only valid for hosted agents",
    );
  }

  if (changingModel) {
    const credential = await resolveAgentLlmCredential(
      { id: agent.id, workspaceId: agent.workspaceId },
      agent.workspace.organizationId,
    );
    if (!credential) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Connect a model key to this agent before choosing a model",
      );
    }

    // Merge against what is already stored, so changing only the effort keeps
    // an existing model override instead of silently clearing it — but ONLY
    // when that stored override still belongs to the granted provider. The
    // read path already ignores a stale stamp (`resolveAgentModel`); without
    // the same rule here, a `PATCH {effort}` on an agent whose key has since
    // changed provider would merge the old model forward and be rejected for a
    // model the caller never sent.
    const stale = agent.modelProvider !== credential.provider;
    const stored = stale
      ? { model: null, effort: null }
      : { model: agent.model, effort: agent.effort };
    const model = patch.model !== undefined ? patch.model : stored.model;
    const effort = patch.effort !== undefined ? patch.effort : stored.effort;

    const definition = llmProvider(credential.provider);

    // The provider's own prefix rule, not membership of the live catalog.
    // Deliberate: validating against the fetched list would make this endpoint
    // depend on an outbound call, so a provider outage would turn the settings
    // page read-only. The rule still rejects the mistake that matters — an id
    // from the wrong provider — and an id that is plausible but unknown to the
    // harness degrades to the default with a notice rather than failing a turn.
    if (model !== null && !definition.isSelectable(model))
      throw new ServiceError(
        "BAD_REQUEST",
        `${model} is not a model your ${credential.provider} key can run`,
      );

    // Effort is validated against THIS provider's levels, not the shared
    // scale: the scale is the union across providers, and the accepted set is
    // per-provider. Storing a level this provider cannot express would be
    // silently dropped at spawn while the UI still called it the user's
    // choice.
    if (effort !== null && !definition.efforts.some((o) => o.id === effort))
      throw new ServiceError(
        "BAD_REQUEST",
        `${effort} is not a thinking level your ${credential.provider} key supports`,
      );

    data.model = model;
    data.effort = effort;
    // The stamp is written HERE, never accepted from the client: it is what
    // makes the override droppable when the granted key changes provider, and
    // a half-set pair is rejected outright by the table's CHECK constraint.
    data.modelProvider =
      model === null && effort === null ? null : credential.provider;
  }

  await db.agent.update({
    where: { id: agentId },
    data,
    // The bare update would read the whole row back — image_data included.
    select: { id: true },
  });

  // A renamed agent's Slack app keeps answering to the old name unless the
  // remote manifest moves with it. Fire-and-forget by design (the helper
  // never throws): the rename itself already committed, and a provider
  // outage must not turn a successful PATCH into an error. Fired FIRST,
  // before every awaited follow-on (respawn, home bump): if one of those
  // throws, the PATCH fails but the rename is committed — a same-name retry
  // would compare equal and never re-fire this.
  if (data.name !== undefined && data.name !== agent.name) {
    const organizationId = agent.workspace?.organizationId;
    if (organizationId) {
      void syncAgentPresenceNames({ id: agentId, organizationId }, data.name);
    }
  }

  // The model is baked into the container's environment at create, so a live
  // sandbox is running the OLD one until it is replaced. Same treatment a
  // grant change gets (`grants-service`), for the same reason.
  //
  // Only when something actually MOVED, though. A respawn destroys the
  // container and fails whatever it was working on ("The agent restarted"), so
  // spending that on a PATCH that re-sends the values already stored — which a
  // settings form does the moment a user changes their mind and changes it
  // back — would be a visible loss for no change at all.
  const modelChanged =
    changingModel &&
    (data.model !== agent.model ||
      data.effort !== agent.effort ||
      data.modelProvider !== agent.modelProvider);

  if (modelChanged) {
    await requestSandboxRespawn(agentId, workspaceId);
    signalWork();
  }

  // The brief and the display name are RENDER inputs, not env — they reach a
  // live sandbox over the home-sync channel (step 9), which re-renders
  // the instruction docs mid-run. A bump, never a respawn: a text edit must
  // not cost the container. (Before step 9 these edits reached a live sandbox
  // never — the bump is strictly an upgrade.) No-op-guarded like the model
  // path, and only for hosted agents (a BYO agent has no sandbox).
  const renderInputsChanged =
    agent.kind === "hosted" &&
    ((data.name !== undefined && data.name !== agent.name) ||
      (data.instructions !== undefined &&
        data.instructions !== agent.instructions));
  if (renderInputsChanged) {
    await bumpHomeForAgent(agentId);
  }
};

export const regenerateAgentToken = async (
  workspaceId: string,
  agentId: string,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, kind: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const accessToken = generateAccessToken();

  const updated = await db.agent.update({
    where: { id: agentId },
    data: { accessToken },
    select: { accessToken: true },
  });

  // A hosted agent's sandbox holds the OLD proxy token in its environment, so
  // regeneration must reach the computer too (§5.1). Declarative rather than
  // bespoke: mark it for respawn and the next poll composes a fresh payload —
  // the same path a first start takes.
  if (agent.kind === "hosted") {
    await requestSandboxRespawn(agentId, workspaceId);
    signalWork();
  }

  return { accessToken: updated.accessToken };
};
