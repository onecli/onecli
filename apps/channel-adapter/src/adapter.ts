import {
  escapeSlackText,
  type AdapterIngestResponse,
  type AdapterPresence,
  type AdapterWorkItem,
} from "@onecli/agent-protocol";
import type { AdapterConfig } from "./config";
import type { ControlPlaneClient } from "./control-plane";
import { createApprovalsManager } from "./approvals";
import { mirrorFinishedTurn } from "./mirror";
import { slackApprovalCardUi } from "./slack/approval-card";
import { postMessage } from "./slack/client";
import { botTokenOf } from "./slack/credentials";
import { slackMirrorPosts } from "./slack/mirror-posts";
import { openSocketMode, type SocketModeConnection } from "./slack/socket-mode";

/**
 * The orchestrator: reconcile provider connections against the config feed,
 * pump events into the control plane's doors, post what the completion pass
 * surfaces, and run the approvals manager. All state is rebuildable — the
 * durable truth (dedupe, cursors, prompt ledger, reaction receipts) lives
 * control-plane-side by design, which is what makes `docker restart` a
 * non-event.
 *
 * Answers are posted ONCE, on completion, by the mirror pass — there is no
 * live rendering (the streaming-edit design was removed; the plan doc records
 * the decision). The "seen" signal while a turn runs is the reaction receipt,
 * which the control plane owns end to end.
 */

interface PresenceRuntime {
  presence: AdapterPresence;
  botToken: string | null;
  socket: SocketModeConnection | null;
}

const credentialsOf = (
  presence: AdapterPresence,
): { botToken: string | null; appToken: string | null } => {
  if (!presence.credentialsJson) return { botToken: null, appToken: null };
  try {
    const parsed = JSON.parse(presence.credentialsJson) as {
      botToken?: string;
      appToken?: string;
    };
    return {
      botToken: parsed.botToken ?? null,
      appToken: parsed.appToken ?? null,
    };
  } catch {
    return { botToken: null, appToken: null };
  }
};

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
    cardUi: slackApprovalCardUi,
    credentialOf: botTokenOf,
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
    const botToken = runtime.botToken;
    if (!botToken) return;
    const iconUrl = runtime.presence.agent.imageUrl ?? undefined;

    if (outcome.kind === "invite") {
      if (outcome.outcome === "refuse" && outcome.channel) {
        if (outcome.message) {
          await postMessage(botToken, {
            channel: outcome.channel,
            text: escapeSlackText(outcome.message),
            ...(iconUrl && { iconUrl }),
          }).catch((err: unknown) => log("refusal post failed", { err }));
        }
        // Slack's door never asks to leave (exiting needs channel-manage
        // scopes — see the control plane's refuse-and-stay-muted decision);
        // the wire field stays for a provider whose exit costs nothing.
        if (outcome.leave) {
          log("leave requested but no provider exit is implemented", {
            channel: outcome.channel,
          });
        }
      }
      return;
    }
    if (outcome.kind === "ignored" || outcome.kind === "duplicate") return;

    const reply = outcome.reply;
    if (!reply) return;
    const send = (text: string) =>
      postMessage(botToken, {
        channel: reply.channel,
        text,
        ...(reply.threadTs && { threadTs: reply.threadTs }),
        ...(iconUrl && { iconUrl }),
      }).catch((err: unknown) => log("reply post failed", { err }));

    if (outcome.kind === "refused") {
      // Covers the follow-up cap too — that refusal must stay visible.
      await send(escapeSlackText(outcome.message));
      return;
    }
    if (outcome.kind === "busy") {
      // Version-skew arm only (an OLD control plane still refuses mid-run
      // messages this way); a current one answers `followUp` instead.
      await send(
        escapeSlackText(
          "Still working on the last message. I'll take this one next.",
        ),
      );
      return;
    }
    // kind === "turn": nothing to post now. The completion pass posts every
    // finished turn's answer — door failures included (they are finished
    // turns, and their `turn.error` is the answer). Posting the error here
    // TOO would double-deliver it.
    // kind === "followUp": nothing to post either — the message joined the
    // live run (or runs next), and its ack is the receipt reaction moving,
    // done control-plane-side.
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
    const { appToken } = credentialsOf(runtime.presence);
    if (!appToken) {
      log("socket presence without app token", {
        presenceId: runtime.presence.presenceId,
      });
      return;
    }
    runtime.socket = openSocketMode(
      { appToken },
      {
        onEvent: ({ event, eventId }) => {
          // The envelope is already acked (Slack's 3s rule), so Slack will
          // NOT redeliver — a transient control-plane failure here would
          // silently drop the user's message. Retry with backoff; ingest is
          // idempotent by eventId, which is exactly what makes retry safe.
          void ingestWithRetry(runtime, { event, eventId });
        },
        onInteractive: (payload) => {
          void handleInteractive(runtime, payload).catch((err: unknown) =>
            log("interactive handling failed", { err }),
          );
        },
        onPermanentFailure: (reason) => {
          log("socket permanently down", {
            presenceId: runtime.presence.presenceId,
            reason,
          });
          runtime.socket = null;
        },
        onLog: (message, detail) =>
          log(`socket(${runtime.presence.agent.name}): ${message}`, detail),
      },
    );
  };

  const handleInteractive = async (
    runtime: PresenceRuntime,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const typed = payload as {
      type?: string;
      user?: { id?: string };
      actions?: { action_id?: string; value?: string }[];
    };
    const action = typed.actions?.[0];
    const clicker = typed.user?.id;
    if (
      typed.type !== "block_actions" ||
      !action?.value ||
      !clicker ||
      (action.action_id !== "channel_approve" &&
        action.action_id !== "channel_deny")
    ) {
      return;
    }
    // Fence the poll loop's absence arm for the round-trip: decide() removes
    // the approval from the gateway's pending set before settleDecided runs,
    // and an unfenced poll in that window would rewrite the card as
    // "decided from the dashboard" — wrong provenance for a click made here.
    approvals.beginDecision(action.value);
    try {
      const decision = await controlPlane.decide({
        presenceId: runtime.presence.presenceId,
        approvalId: action.value,
        decision: action.action_id === "channel_approve" ? "approve" : "deny",
        clickerExternalUserId: clicker,
      });
      const text =
        decision.kind === "decided"
          ? `${action.action_id === "channel_approve" ? "✅ Approved" : "⛔ Denied"} by ${escapeSlackText(decision.decidedByName)}`
          : decision.kind === "already_settled"
            ? "This request was already decided."
            : escapeSlackText(decision.message);
      await approvals.settleDecided(action.value, text);
    } finally {
      approvals.endDecision(action.value);
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

    for (const [presenceId, presence] of wanted) {
      const existing = runtimes.get(presenceId);
      const { botToken } = credentialsOf(presence);
      if (!existing) {
        const runtime: PresenceRuntime = { presence, botToken, socket: null };
        runtimes.set(presenceId, runtime);
        if (presence.transport === "socket") openSocket(runtime);
        log("presence added", {
          presenceId,
          transport: presence.transport,
          agent: presence.agent.name,
        });
      } else {
        existing.presence = presence;
        existing.botToken = botToken;
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
  };

  // ── Work handling ───────────────────────────────────────────────────────

  const handleFinished = async (item: AdapterWorkItem): Promise<void> => {
    const runtime = runtimes.get(item.presenceId);
    if (!runtime?.botToken) return;
    const { agent } = runtime.presence;
    const next = await mirrorFinishedTurn({
      controlPlane,
      credential: runtime.botToken,
      provider: runtime.presence.provider,
      posts: slackMirrorPosts,
      iconUrl: runtime.presence.agent.imageUrl ?? null,
      knownCursor: cursors.get(item.linkId) ?? null,
      item,
      // The agent's Models page — where a key-problem answer's button points.
      ...(config.appUrl && {
        modelsUrl: `${config.appUrl}/w/${encodeURIComponent(agent.workspaceId)}/agents/${encodeURIComponent(agent.id)}/models`,
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
      await approvals.recoverUnsettled().catch((err: unknown) => {
        log("unsettled-prompt recovery failed", { err: String(err) });
      });
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
