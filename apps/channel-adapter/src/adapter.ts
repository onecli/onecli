import type {
  AdapterIngestResponse,
  AdapterPresence,
  AdapterWorkItem,
} from "@onecli/agent-protocol";
import type { AdapterConfig } from "./config";
import type { ControlPlaneClient } from "./control-plane";
import { createApprovalsManager } from "./approvals";
import { mirrorFinishedTurn } from "./mirror";
import {
  channelAdapterProviderFor,
  type ChannelAdapterProvider,
  type ProviderTransport,
} from "./providers";

/**
 * The orchestrator: reconcile provider connections against the config feed,
 * pump events into the control plane's doors, post what the completion pass
 * surfaces, and run the approvals manager. All state is rebuildable — the
 * durable truth (dedupe, cursors, prompt ledger, reaction receipts) lives
 * control-plane-side by design, which is what makes `docker restart` a
 * non-event.
 *
 * Provider-neutral by construction: every channel-shaped decision — the
 * credential's JSON shape, the transport's dialing, outcome copy, decision
 * rendering — lives behind the `ChannelAdapterProvider` seam (providers.ts;
 * Slack: slack/adapter-provider.ts). A presence whose provider this build
 * does not know is SKIPPED loudly rather than run half-way: the config
 * feed's provider field is an open string precisely so a newer control
 * plane's second provider cannot brick the whole slice (version skew).
 *
 * Answers are posted ONCE, on completion, by the mirror pass — there is no
 * live rendering (the streaming-edit design was removed; the plan doc records
 * the decision). The "seen" signal while a turn runs is the reaction receipt,
 * which the control plane owns end to end.
 */

interface PresenceRuntime {
  presence: AdapterPresence;
  provider: ChannelAdapterProvider;
  credential: string | null;
  socket: ProviderTransport | null;
}

export interface AdapterDeps {
  config: AdapterConfig;
  controlPlane: ControlPlaneClient;
  log: (message: string, detail?: unknown) => void;
}

export const createAdapter = ({ config, controlPlane, log }: AdapterDeps) => {
  const runtimes = new Map<string, PresenceRuntime>();
  /** linkId → the cursor as this adapter last saw it (the CAS expectation). */
  const cursors = new Map<string, string | null>();
  const approvals = createApprovalsManager({
    controlPlane,
    gatewayUrl: config.gatewayUrl,
    approvalsPollSeconds: config.approvalsPollSeconds,
    // Per-presence resolution through the registry: the approvals manager
    // stays channel-general and only ever sees the seam. Null for a
    // provider this build does not know — the manager treats it as a
    // presence it cannot serve yet.
    cardUiOf: (presence) =>
      channelAdapterProviderFor(presence.provider)?.cardUi ?? null,
    credentialOf: (presence) =>
      channelAdapterProviderFor(presence.provider)?.credentialOf(presence) ??
      null,
    onLog: log,
  });

  let stopped = false;
  let etag: string | null = null;

  // ── Outcome handling (shared by the socket pump; the events arm's copy of
  // this lives in the inbound route, request-scoped) ────────────────────────

  const respondToOutcome = async (
    runtime: PresenceRuntime,
    outcome: AdapterIngestResponse,
  ): Promise<void> => {
    const credential = runtime.credential;
    if (!credential) return;
    const iconUrl = runtime.presence.agent.imageUrl ?? undefined;
    await runtime.provider.respondToOutcome({
      credential,
      ...(iconUrl && { iconUrl }),
      outcome,
      onLog: log,
    });
  };

  // ── The socket pump ─────────────────────────────────────────────────────

  /** Ingest with bounded retry — the envelope is acked, so a dropped message
   * is gone unless we re-attempt. Idempotent by eventId (control-plane dedupe),
   * so a retry that races a slow success is a harmless `duplicate`. */
  const ingestWithRetry = async (
    runtime: PresenceRuntime,
    input: { event: unknown; eventId: string },
  ): Promise<void> => {
    let delay = 500;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (stopped) return;
      try {
        const outcome = await controlPlane.ingest({
          presenceId: runtime.presence.presenceId,
          eventId: input.eventId,
          event: input.event,
        });
        await respondToOutcome(runtime, outcome);
        return;
      } catch (err) {
        if (attempt === 4) {
          log("ingest failed after retries", { err: String(err) });
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 8_000);
      }
    }
  };

  const openSocket = (runtime: PresenceRuntime): void => {
    runtime.socket = runtime.provider.openTransport(runtime.presence, {
      onEvent: ({ event, eventId }) => {
        // The envelope is already acked (the channel's delivery rule — for
        // Slack the 3s ack window), so the provider will NOT redeliver — a
        // transient control-plane failure here would silently drop the
        // user's message. Retry with backoff; ingest is idempotent by
        // eventId, which is exactly what makes retry safe.
        void ingestWithRetry(runtime, { event, eventId });
      },
      onApprovalDecision: (decision) => {
        void handleApprovalDecision(runtime, decision).catch((err: unknown) =>
          log("interactive handling failed", { err }),
        );
      },
      onReachDecision: (decision) => {
        // Forward-only: the control plane authorizes the clicker, flips the
        // grant, and rewrites every posted owner card itself (promptRefs) -
        // the adapter owes the wire nothing further, so no settle path here.
        void controlPlane
          .decideReach({
            presenceId: runtime.presence.presenceId,
            grantId: decision.grantId,
            decision: decision.decision,
            clickerExternalUserId: decision.clickerExternalUserId,
          })
          .catch((err: unknown) =>
            log("reach decision forward failed", { err }),
          );
      },
      onPermanentFailure: (reason) => {
        log("socket permanently down", {
          presenceId: runtime.presence.presenceId,
          reason,
        });
        runtime.socket = null;
      },
      onLog: log,
    });
  };

  const handleApprovalDecision = async (
    runtime: PresenceRuntime,
    input: {
      approvalId: string;
      decision: "approve" | "deny";
      clickerExternalUserId: string;
    },
  ): Promise<void> => {
    // Fence the poll loop's absence arm for the round-trip: decide() removes
    // the approval from the gateway's pending set before settleDecided runs,
    // and an unfenced poll in that window would rewrite the card as
    // "decided from the dashboard" — wrong provenance for a click made here.
    approvals.beginDecision(input.approvalId);
    try {
      const decision = await controlPlane.decide({
        presenceId: runtime.presence.presenceId,
        approvalId: input.approvalId,
        decision: input.decision,
        clickerExternalUserId: input.clickerExternalUserId,
      });
      const text = runtime.provider.decisionSettledText({
        decision: input.decision,
        result: decision,
      });
      await approvals.settleDecided(input.approvalId, text);
    } finally {
      approvals.endDecision(input.approvalId);
    }
  };

  // ── Reconcile against the config feed ───────────────────────────────────

  const applyConfig = (presences: AdapterPresence[]): void => {
    const wanted = new Map(presences.map((p) => [p.presenceId, p] as const));

    for (const [presenceId, runtime] of runtimes) {
      if (!wanted.has(presenceId)) {
        runtime.socket?.close();
        runtimes.delete(presenceId);
        log("presence removed", { presenceId });
      }
    }

    let acquired = false;
    for (const [presenceId, presence] of wanted) {
      const existing = runtimes.get(presenceId);
      // The version-skew arm: a newer control plane may feed a provider this
      // build has no implementation for. Skipping the presence — loudly, and
      // WITHOUT a runtime — keeps the rest of the slice serving; the control
      // plane keeps owning the conversation state, so nothing is lost when a
      // newer adapter picks it up.
      const provider = channelAdapterProviderFor(presence.provider);
      if (!provider) {
        log("unknown provider, skipping presence", {
          presenceId,
          provider: presence.provider,
        });
        continue;
      }
      const credential = provider.credentialOf(presence);
      if (!existing) {
        acquired = true;
        const runtime: PresenceRuntime = {
          presence,
          provider,
          credential,
          socket: null,
        };
        runtimes.set(presenceId, runtime);
        if (presence.transport === "socket") openSocket(runtime);
        log("presence added", {
          presenceId,
          transport: presence.transport,
          agent: presence.agent.name,
        });
      } else {
        existing.presence = presence;
        existing.provider = provider;
        existing.credential = credential;
        // A socket presence whose connection died permanently is retried
        // whenever the config changes (a re-attach rotates credentials).
        if (presence.transport === "socket" && !existing.socket) {
          openSocket(existing);
        }
      }

      for (const link of presence.links) {
        if (!cursors.has(link.id)) cursors.set(link.id, link.mirrorCursor);
      }
    }

    approvals.reconcile(presences);

    // A presence APPEARING in the feed is ownership acquired — a boot's first
    // feed (all-adds) or a dead peer's slice failing over to us. Re-arm its
    // unsettled approval cards against the real gateway deadlines: the
    // endpoint is owner-scoped, so this is exactly our slice, and re-arming a
    // prompt we already track just overwrites the same entry. Without this a
    // dead claimer's cards strand until some instance RESTARTS.
    if (acquired) {
      void approvals.recoverUnsettled().catch((err: unknown) => {
        log("unsettled-prompt recovery failed", { err: String(err) });
      });
    }
  };

  // ── Work handling ───────────────────────────────────────────────────────

  const handleFinished = async (item: AdapterWorkItem): Promise<void> => {
    const runtime = runtimes.get(item.presenceId);
    if (!runtime?.credential) return;
    const { agent } = runtime.presence;
    const next = await mirrorFinishedTurn({
      controlPlane,
      credential: runtime.credential,
      provider: runtime.presence.provider,
      posts: runtime.provider.posts,
      iconUrl: runtime.presence.agent.imageUrl ?? null,
      // Local cache first; a link acquired mid-history falls back to the
      // item's server-supplied floor (an instance-identity etag no longer
      // folds cursors, so the config feed can't be the only seed source — a
      // null seed against a non-null DB cursor would CAS-fail forever).
      knownCursor: cursors.get(item.linkId) ?? item.linkMirrorCursor ?? null,
      item,
      // The agent's Models page — where a key-problem answer's button points.
      ...(config.appUrl && {
        modelsUrl: `${config.appUrl}/w/${encodeURIComponent(agent.workspaceId)}/agents/${encodeURIComponent(agent.id)}/models`,
        // The agent's chat — connect-card buttons land the user back in the
        // conversation with the attach dialog open.
        chatUrl: `${config.appUrl}/w/${encodeURIComponent(agent.workspaceId)}/agents/${encodeURIComponent(agent.id)}/chat`,
      }),
      onLog: log,
    });
    if (next !== null) cursors.set(item.linkId, next);
    else cursors.delete(item.linkId); // lost the CAS — re-seed from config
  };

  // ── Loops ───────────────────────────────────────────────────────────────

  // These parked timers are what keep the PROCESS alive between polls — the
  // loops are the daemon. An unref'd timer here means "exit whenever", and
  // the process dies silently right after boot (nothing else holds the event
  // loop once registration completes). Shutdown never waits on them either
  // way: index.ts's drain timer hard-exits after stop().
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const configLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const config_ = await controlPlane.getConfig(etag);
        if (config_) {
          etag = config_.etag;
          applyConfig(config_.presences);
        }
      } catch (err) {
        log("config poll failed", { err: String(err) });
      }
      await sleep(config.configPollMs);
    }
  };

  const workLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const work = await controlPlane.getWork();
        for (const item of work.finished) {
          await handleFinished(item);
        }
      } catch (err) {
        log("work poll failed", { err: String(err) });
      }
      await sleep(config.workPollMs);
    }
  };

  /**
   * The proactive credential sweep, ~hourly. The control plane decides
   * staleness (rotates what hasn't rotated in ~6h) — this loop just makes
   * sure an IDLE install still rotates, because an unused refresh token's
   * longevity is undocumented on Slack's side. Lives here rather than in the
   * control plane so the api keeps its no-background-loop law (§3.3).
   */
  const rotationLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const result = await controlPlane.rotateIntegrations();
        if (result.rotated > 0 || result.failed > 0) {
          log("integration credential sweep", result);
        }
      } catch (err) {
        log("credential sweep failed", { err: String(err) });
      }
      await sleep(60 * 60 * 1000);
    }
  };

  return {
    async start(): Promise<void> {
      // Unsettled-prompt recovery rides ownership acquisition inside
      // applyConfig (the first feed is all-adds, so boot is covered) — the
      // endpoint is owner-scoped, and before the first claim it would answer
      // an empty slice here anyway.
      void configLoop();
      void workLoop();
      void rotationLoop();
    },
    stop(): void {
      stopped = true;
      approvals.stop();
      for (const runtime of runtimes.values()) runtime.socket?.close();
      runtimes.clear();
    },
  };
};
