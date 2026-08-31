import { z } from "zod";
import type { AdapterPresence } from "@onecli/agent-protocol";
import type { ControlPlaneClient } from "./control-plane";
import { replyTargetForLink, type ChannelPostTarget } from "./targets";

/**
 * The approvals surface: per presence, long-poll the GATEWAY's pending list
 * with the presence's service key, post one card per approval, and settle
 * the card on decision or expiry.
 *
 * Channel-general by design: this module never renders. What a card looks
 * like — and how it is delivered — is the injected `ApprovalCardUi`'s
 * business (Slack's implementation lives in slack/approval-card.ts); a
 * second channel implements the same seam. Settle copy here is plain,
 * channel-neutral text.
 *
 * Restart-safe by the control plane's `ChannelApprovalPrompt` ledger: a card
 * is CLAIMED (unique by approval id) before it is posted, so a restarted or
 * twin adapter never re-posts; the message ref is recorded so any instance
 * can update the card later; unsettled prompts are re-armed at boot.
 *
 * The card carries ONLY the opaque approval id in its button values (the
 * channel payload cap and the injection rule both point the same way);
 * everything else stays server-side. Decisions are forwarded to the control
 * plane, which authorizes the CLICKER as a workspace member before the
 * gateway is asked anything — the fence is never channel-side.
 */

const pendingResponse = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      method: z.string().optional(),
      host: z.string().optional(),
      path: z.string().optional(),
      summary: z
        .object({
          action: z.string().optional(),
          details: z
            .array(z.object({ label: z.string(), value: z.string() }))
            .optional(),
        })
        .nullish(),
      agent: z.object({ id: z.string(), name: z.string() }).partial().nullish(),
      expiresAt: z.string().optional(),
    }),
  ),
  timeoutSeconds: z.number().optional(),
});
export type PendingApproval = z.infer<
  typeof pendingResponse
>["requests"][number];

export class ApprovalsAuthError extends Error {}

/** One long-poll against the gateway (it holds ~30s when the list is empty). */
export const fetchPendingApprovals = async (input: {
  gatewayUrl: string;
  serviceKey: string;
  excludeIds: string[];
  timeoutMs: number;
}): Promise<PendingApproval[]> => {
  const exclude = input.excludeIds.length
    ? `?exclude=${encodeURIComponent(input.excludeIds.join(","))}`
    : "";
  const response = await fetch(
    `${input.gatewayUrl}/v1/approvals/pending${exclude}`,
    {
      headers: { authorization: `Bearer ${input.serviceKey}` },
      signal: AbortSignal.timeout(input.timeoutMs),
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new ApprovalsAuthError(`gateway refused: ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`gateway approvals answered ${response.status}`);
  }
  return pendingResponse.parse(await response.json()).requests;
};

/**
 * What a channel must provide to carry approval cards. Rendering and
 * transport live behind this seam (Slack: slack/approval-card.ts); the
 * manager below owns everything channel-independent — the poll loop, the
 * ledger protocol, expiry, and cross-surface settlement.
 */
export interface ApprovalCardUi {
  /** Post the card for a pending approval; returns the channel-native
   * message ref. Throws on failure (the caller owns retry semantics). */
  post(
    input: ChannelPostTarget & { approval: PendingApproval },
  ): Promise<{ channel: string; ts: string }>;
  /** Rewrite a posted card with plain settled text, prefixed by the
   * approval's action title when one is known — a settled card must still
   * say WHAT was asked, or a thread of settled cards is unreadable. Throws
   * on failure, EXCEPT when the card is permanently gone (deleted message,
   * archived channel): a card that no longer exists cannot mislead anyone,
   * so implementations treat that as settled rather than retrying forever. */
  settle(input: {
    credential: string;
    channel: string;
    ts: string;
    text: string;
    title: string | null;
  }): Promise<void>;
}

interface TrackedPrompt {
  approvalId: string;
  presenceId: string;
  channel: string;
  ts: string | null;
  expiresAt: number | null;
  /** The approval's action title, for outcome rewrites ("what was asked").
   * Null for prompts recovered from the ledger (it records no title). */
  title: string | null;
}

export interface ApprovalsManagerDeps {
  controlPlane: ControlPlaneClient;
  gatewayUrl: string;
  approvalsPollSeconds: number;
  /** Resolve a presence's card rendering (the channel's business — Slack:
   * slack/approval-card.ts, handed out via the provider registry). Null for
   * a provider this build cannot serve — its prompts stay tracked untouched,
   * the same way a missing credential parks them. */
  cardUiOf: (presence: AdapterPresence) => ApprovalCardUi | null;
  /** Extract the channel credential from a presence (the credential's shape
   * is the channel's business — Slack: slack/credentials.ts). */
  credentialOf: (presence: AdapterPresence) => string | null;
  /** Poll pacing while cards are outstanding (the gateway answers instantly
   * then). Injectable so tests don't sleep real seconds. */
  pacingMs?: number;
  onLog: (message: string, detail?: unknown) => void;
}

/**
 * The per-adapter approvals manager: one poll loop per presence that holds a
 * service key, plus the shared prompt ledger.
 */
export const createApprovalsManager = (deps: ApprovalsManagerDeps) => {
  const loops = new Map<string, { stop: () => void }>();
  const prompts = new Map<string, TrackedPrompt>();
  /** The live presence view, refreshed on every reconcile — the running loops
   * read it so new links and rotated keys take effect without a restart. */
  const presenceById = new Map<string, AdapterPresence>();
  let expiryTimer: ReturnType<typeof setInterval> | undefined;

  const tokenFor = new Map<string, string>();
  /** presenceId → the presence's card rendering, resolved alongside the
   * credential on every reconcile (same lifetime as `tokenFor`). */
  const cardUiFor = new Map<string, ApprovalCardUi>();

  /** Approval ids whose decision is in flight on THIS channel (a click being
   * forwarded to the control plane). The cross-surface absence arm skips
   * them: the control plane's decide() removes the approval from the
   * gateway's pending set BEFORE settleDecided rewrites the card, so an
   * unfenced poll in that window would win the rewrite with the wrong
   * provenance. The expiry sweep stays unfenced — the deadline is truth. */
  const deciding = new Set<string>();

  /**
   * Card FIRST, ledger second, untrack last: once the ledger settles, no
   * instance ever looks at this prompt again, so settling before the rewrite
   * lands strands a live-looking card (missing credential during boot,
   * instance death between the two calls). Any failure keeps the prompt
   * tracked — the caller's cadence (the 5s sweep, or the poll loop's next
   * absence) retries the whole pair; a missing credential (config feed
   * pending) just leaves it tracked the same way.
   */
  const settleTracked = async (
    prompt: TrackedPrompt,
    state: "decided" | "expired",
    text: string,
  ): Promise<void> => {
    if (prompt.ts) {
      const credential = tokenFor.get(prompt.presenceId);
      const cardUi = cardUiFor.get(prompt.presenceId);
      if (!credential || !cardUi) return;
      await cardUi.settle({
        credential,
        channel: prompt.channel,
        ts: prompt.ts,
        text,
        title: prompt.title,
      });
    }
    await deps.controlPlane.settlePrompt(prompt.approvalId, state);
    prompts.delete(prompt.approvalId);
  };

  const settleExpired = async (): Promise<void> => {
    const now = Date.now();
    for (const prompt of [...prompts.values()]) {
      if (prompt.expiresAt === null || prompt.expiresAt > now) continue;
      try {
        await settleTracked(
          prompt,
          "expired",
          "Expired (no response) · denied",
        );
      } catch (err) {
        deps.onLog("expiry settle failed; will retry", { err: String(err) });
      }
    }
  };

  /** The swallow-wrapper for decision-path rewrites: the outcome is already
   * settled elsewhere (the ledger via the control plane's decide), so a
   * failed rewrite is cosmetic — log and move on. */
  const settleCardSafe = async (
    prompt: TrackedPrompt,
    text: string,
  ): Promise<void> => {
    const credential = tokenFor.get(prompt.presenceId);
    const cardUi = cardUiFor.get(prompt.presenceId);
    if (!credential || !cardUi || !prompt.ts) return;
    try {
      await cardUi.settle({
        credential,
        channel: prompt.channel,
        ts: prompt.ts,
        text,
        title: prompt.title,
      });
    } catch (err) {
      deps.onLog("card update failed", { err: String(err) });
    }
  };

  /** A decided approval (the interactivity path already updated the card via
   * response_url on the events arm; the socket arm calls this). */
  const settleDecided = async (
    approvalId: string,
    text: string,
  ): Promise<void> => {
    const prompt = prompts.get(approvalId);
    prompts.delete(approvalId);
    if (prompt) await settleCardSafe(prompt, text);
  };

  const postCard = async (
    presenceId: string,
    approval: PendingApproval,
  ): Promise<void> => {
    // Read the CURRENT presence, not a snapshot captured when the loop began —
    // a card that arrives before the agent's first DM must find its home once
    // the DM (and its link) shows up in a later config feed.
    const presence = presenceById.get(presenceId);
    const credential = presence ? tokenFor.get(presenceId) : undefined;
    const cardUi = presence ? cardUiFor.get(presenceId) : undefined;
    if (!presence || !credential || !cardUi) return;

    // Where the card goes: the presence's direct thread when there is one,
    // else its first link. No home at all → leave it unclaimed; a later poll
    // retries once a DM exists.
    const link =
      presence.links.find((l) => l.kind === "direct") ?? presence.links[0];
    if (!link) return;
    const target = replyTargetForLink(link);

    const claimed = await deps.controlPlane.claimPrompt({
      approvalId: approval.id,
      presenceId,
      externalThreadId: link.externalThreadId,
      expiresAt: approval.expiresAt ?? null,
    });
    if (!claimed) return;

    const posted = await cardUi.post({
      credential,
      channel: target.channel,
      ...(target.threadTs && { threadTs: target.threadTs }),
      ...(presence.agent.imageUrl && { iconUrl: presence.agent.imageUrl }),
      approval,
    });
    await deps.controlPlane.recordPromptMessage(
      approval.id,
      `${posted.channel}:${posted.ts}`,
    );
    prompts.set(approval.id, {
      approvalId: approval.id,
      presenceId,
      channel: posted.channel,
      ts: posted.ts,
      expiresAt: approval.expiresAt
        ? new Date(approval.expiresAt).getTime()
        : null,
      title: approval.summary?.action ?? null,
    });
  };

  const runLoop = (presenceId: string): void => {
    let stopped = false;
    let healthy = true;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        const presence = presenceById.get(presenceId);
        const serviceKey = presence?.approvalsKey;
        if (!serviceKey) {
          // Not (yet) usable — wait for a config feed that gives it a key.
          await sleep(5_000, () => stopped);
          continue;
        }
        try {
          // NO exclude list: the response is the full pending set, so a
          // tracked card that is absent from it was decided somewhere else
          // (the web, another surface) — that absence is the only signal the
          // adapter gets. The gateway long-polls only when the set is empty,
          // so while cards are up the sleep below provides the pacing.
          const pending = await fetchPendingApprovals({
            gatewayUrl: deps.gatewayUrl,
            serviceKey,
            excludeIds: [],
            timeoutMs: (deps.approvalsPollSeconds + 10) * 1000,
          });
          if (!healthy) {
            // Flip the flag only AFTER the report lands, so a failed report
            // doesn't leave the dashboard stuck on "needs attention".
            await deps.controlPlane.reportApprovalHealth(presenceId, true);
            healthy = true;
          }
          // Settle cards whose approval left the pending set: decided from
          // another surface. The absence signal is ambiguous near the
          // deadline — the gateway auto-denies and removes at ITS clock, a
          // beat before ours reaches expiresAt — so an absence inside the
          // final 15s window is treated as the expiry it almost certainly
          // is. Both arms settle card-first via settleTracked: a failure
          // keeps the prompt tracked, and the absence persisting into the
          // next poll retries the pair.
          const pendingIds = new Set(pending.map((a) => a.id));
          for (const prompt of [...prompts.values()]) {
            if (prompt.presenceId !== presenceId) continue;
            if (pendingIds.has(prompt.approvalId)) continue;
            // A click on THIS card is mid-flight: decide() already removed
            // the approval from the pending set, and settleDecided is about
            // to rewrite the card with the real outcome — an absence settle
            // here would win the race with the wrong provenance.
            if (deciding.has(prompt.approvalId)) continue;
            if (
              prompt.expiresAt !== null &&
              prompt.expiresAt - 15_000 <= Date.now()
            ) {
              // At/near the deadline: expire NOW rather than waiting out the
              // sweep against a local clock the gateway already beat.
              try {
                await settleTracked(
                  prompt,
                  "expired",
                  "Expired (no response) · denied",
                );
              } catch (err) {
                deps.onLog("expiry settle failed; will retry", {
                  err: String(err),
                });
              }
              continue;
            }
            try {
              await settleTracked(
                prompt,
                "decided",
                "Decided from the dashboard",
              );
            } catch (err) {
              deps.onLog("cross-surface settle failed; will retry", {
                err: String(err),
              });
            }
          }
          for (const approval of pending) {
            if (prompts.has(approval.id)) continue;
            // The gateway's pending list is WORKSPACE-scoped, but this loop
            // is one presence — one agent's channel home. Another agent's
            // approval must not land here (its own presence, if any, posts
            // it). An approval without an agent id (older gateway) keeps the
            // legacy post-everywhere behavior rather than vanishing.
            const approvalAgentId = approval.agent?.id;
            if (
              approvalAgentId !== undefined &&
              approvalAgentId !== presence.agent.id
            )
              continue;
            await postCard(presenceId, approval);
          }
          // Pace on what the fetch actually did: the gateway long-polls only
          // when the pending set is EMPTY, so any non-empty answer came back
          // instantly — including sets this presence tracks nothing from
          // (another agent's fenced approval, a card with no home yet, a
          // lost claim), which would otherwise hot-loop against the gateway
          // for the approval's whole lifetime. Empty set → the fetch itself
          // long-polled, no extra sleep.
          if (pending.length > 0) {
            await sleep(deps.pacingMs ?? 3_000, () => stopped);
          }
        } catch (err) {
          if (err instanceof ApprovalsAuthError) {
            if (healthy) {
              try {
                await deps.controlPlane.reportApprovalHealth(presenceId, false);
                healthy = false;
              } catch {
                // Couldn't report — stay "healthy" so the next 401 retries the
                // report rather than silently never flagging it.
              }
              deps.onLog("approvals key refused; presence flagged", {
                presenceId,
              });
            }
            // Back off hard on a refusal — nothing changes until re-attach.
            await sleep(60_000, () => stopped);
            continue;
          }
          deps.onLog("approvals poll failed", { err: String(err) });
          await sleep(5_000, () => stopped);
        }
      }
    };
    void loop();
    loops.set(presenceId, {
      stop: () => {
        stopped = true;
      },
    });
  };

  return {
    /**
     * The expiry sweep, callable directly — exactly what the 5s interval
     * runs. Exposed so the sweep's behavior is testable on REAL timers
     * (faking the clock around live HTTP is what made the old expiry test
     * hang on CI); the interval's own wiring is pinned by the health test's
     * timer count.
     */
    sweepExpired: settleExpired,

    /** Reconcile the poll loops against the current presence set. */
    reconcile(presences: AdapterPresence[]): void {
      const wanted = new Map(
        presences
          .filter((p) => p.approvalsKey)
          .map((p) => [p.presenceId, p] as const),
      );
      // Refresh the live view FIRST, so running loops immediately see new
      // links / rotated keys without a restart.
      presenceById.clear();
      for (const [presenceId, presence] of wanted) {
        presenceById.set(presenceId, presence);
        const credential = deps.credentialOf(presence);
        if (credential) tokenFor.set(presenceId, credential);
        const cardUi = deps.cardUiOf(presence);
        if (cardUi) cardUiFor.set(presenceId, cardUi);
      }
      for (const [presenceId, loop] of loops) {
        if (!wanted.has(presenceId)) {
          loop.stop();
          loops.delete(presenceId);
          presenceById.delete(presenceId);
          tokenFor.delete(presenceId);
          cardUiFor.delete(presenceId);
        }
      }
      for (const presenceId of wanted.keys()) {
        if (!loops.has(presenceId)) runLoop(presenceId);
      }
      if (!expiryTimer) {
        expiryTimer = setInterval(() => void settleExpired(), 5_000);
        expiryTimer.unref?.();
      }
    },

    /** Recovery sweep — at boot and on every ownership acquisition: re-arm
     * cards the ledger says are still pending, against the REAL gateway
     * deadline (not a guess). */
    async recoverUnsettled(): Promise<void> {
      const unsettled = await deps.controlPlane.listUnsettledPrompts();
      for (const prompt of unsettled) {
        // Never clobber a LIVE tracked prompt: acquisition sweeps run while
        // this instance's own claims are mid-flight, and re-seeding from the
        // ledger would reset a fresher `ts`/`title` (a card between claim and
        // record-message would strand looking live). Recovery is for prompts
        // we are NOT tracking — a dead peer's, or our own after a restart.
        if (prompts.has(prompt.approvalId)) continue;
        const ref = prompt.externalMessageRef;
        const separator = ref?.indexOf(":") ?? -1;
        prompts.set(prompt.approvalId, {
          approvalId: prompt.approvalId,
          presenceId: prompt.agentChannelId,
          channel:
            ref && separator > 0
              ? ref.slice(0, separator)
              : prompt.externalThreadId,
          ts: ref && separator > 0 ? ref.slice(separator + 1) : null,
          // The gateway's own recorded deadline, so a fast restart never marks
          // a still-live approval timed-out early. A row with no recorded
          // expiry (older) gets one sweep cycle to settle.
          expiresAt: prompt.expiresAt
            ? new Date(prompt.expiresAt).getTime()
            : Date.now() + 5_000,
          title: null,
        });
      }
    },

    /** Fence one approval from the cross-surface absence arm while its
     * channel-click decision round-trips (see `deciding`). Always pair with
     * `endDecision` in a finally. */
    beginDecision(approvalId: string): void {
      deciding.add(approvalId);
    },
    endDecision(approvalId: string): void {
      deciding.delete(approvalId);
    },

    settleDecided,

    stop(): void {
      for (const loop of loops.values()) loop.stop();
      loops.clear();
      if (expiryTimer) clearInterval(expiryTimer);
      expiryTimer = undefined;
    },
  };
};

const sleep = (ms: number, cancelled: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    if (cancelled()) {
      clearTimeout(timer);
      resolve();
    }
  });
