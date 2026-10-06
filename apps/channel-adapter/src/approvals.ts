import { z } from "zod";
import type { AdapterLink, AdapterPresence } from "@onecli/agent-protocol";
import { APPROVAL_GROUP_ID_RE, APPROVAL_GROUP_MAX_IDS } from "@onecli/channels";
import { approvalGroupKey } from "@onecli/api/lib/approval-groups";
import type { ControlPlaneClient } from "./control-plane";
import {
  replyTargetForLink,
  type ChannelPostTarget,
  type ThreadAddressDecoder,
} from "./targets";

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
 * Restart-safe by the control plane's `ToolApprovalCard` ledger: a card
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

/** A detail's record link: the gateway builds it (https, the connection's
 *  own host), and it is re-checked here, once for every channel, so a card
 *  UI only ever sees an https URL. Anything else is dropped, never fatal: the
 *  detail still renders as plain text. */
const recordUrl = z
  .url({ protocol: /^https$/ })
  .optional()
  .catch(undefined);

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
          // The title's action without its record: grouping keys on it, so
          // per-record titles ("Delete Contact Ada") still share a card.
          subject: z.object({ verb: z.string() }).partial().nullish(),
          details: z
            .array(
              z.object({
                label: z.string(),
                value: z.string(),
                url: recordUrl,
              }),
            )
            .optional(),
        })
        .nullish(),
      agent: z.object({ id: z.string(), name: z.string() }).partial().nullish(),
      app: z.string().optional().catch(undefined),
      batch: z
        .object({
          id: z.string(),
          label: z.string().optional(),
          total: z.number().optional(),
        })
        .nullish(),
      createdAt: z.string().optional(),
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
  /** The channel-native message ref as ONE opaque string for the ledger
   * (`externalMessageRef`) — how a posted card is found again after a
   * restart or by a peer instance. The provider owns the encoding. */
  packMessageRef(ref: { channel: string; ts: string }): string;
  /** The inverse; null for an absent or malformed ref (a recovered prompt
   * degrades to its thread address, never throws). */
  unpackMessageRef(
    ref: string | null | undefined,
  ): { channel: string; ts: string } | null;
  /** OPTIONAL: rewrite a posted card in place as one GROUPED card for
   * several approvals of one task (the first approval posts it through
   * `post`). A channel without it gets one card per approval (the manager
   * never groups). Throws on failure, EXCEPT a permanently-gone card (as
   * `settle`). */
  renderGroup?(input: {
    credential: string;
    channel: string;
    ts: string;
    view: GroupCardView;
  }): Promise<void>;
}

/** How one grouped approval ended, for the card's done list. */
type GroupOutcome = "approved" | "denied" | "expired" | "decided";

export interface GroupCardView {
  /** Still pending, oldest first: exactly the ids the buttons carry. */
  live: PendingApproval[];
  /** Already settled members of this card, oldest first. */
  settled: {
    id: string;
    title: string | null;
    /** The agent's own name for the task (its batch label), kept so the
     *  finished card still reads "Import 8 leads" once no row is live. */
    label?: string;
    outcome: GroupOutcome;
    by?: string;
  }[];
}

interface TrackedPrompt {
  approvalId: string;
  presenceId: string;
  /**
   * The posted card's message ref, PACKED (provider-opaque), exactly as the
   * ledger stores it — decoded by the presence's own card UI at settle time,
   * which is the only moment the provider is guaranteed known (recovery
   * runs before the presence is necessarily owned here). Null when the
   * ledger recorded no message (claimed, never posted).
   */
  messageRef: string | null;
  /** The thread the card was claimed in (the ledger's `externalThreadId`),
   * so a card rebuilt after a restart knows where it sits. */
  externalThreadId: string;
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
  /** The presence's provider's thread-address decoder (targets.ts). */
  threadAddressOf: (presence: AdapterPresence) => ThreadAddressDecoder | null;
  /** Extract the channel credential from a presence (the credential's shape
   * is the channel's business — Slack: slack/credentials.ts). */
  credentialOf: (presence: AdapterPresence) => string | null;
  /** Poll pacing while cards are outstanding (the gateway answers instantly
   * then). Injectable so tests don't sleep real seconds. */
  pacingMs?: number;
  /** How long a grouped card waits for more arrivals before re-rendering
   * (coalesces a burst into one chat.update). Injectable for tests. */
  groupDebounceMs?: number;
  onLog: (message: string, detail?: unknown) => void;
}

/** One posted message carrying several approvals of one task. */
interface GroupCard {
  presenceId: string;
  key: string | null;
  messageRef: string;
  /** The thread the card was posted in (the ledger's `externalThreadId`).
   * A new approval joins only while this is still the presence's card home,
   * so a card left in a thread that stopped being the home never grows. */
  externalThreadId: string;
  /** Pending members, arrival order. Null details = recovered from the
   * ledger and not yet seen in a poll (the render waits for them). */
  live: Map<string, PendingApproval | null>;
  settled: GroupCardView["settled"];
  timer: ReturnType<typeof setTimeout> | null;
  /** Serializes renders so a later state never loses to an earlier one. */
  chain: Promise<void>;
}

/**
 * Where a presence's approval cards go: the APPROVER's own direct thread,
 * named by the control plane (`approvalsLinkId`). Never a guest's DM:
 * someone allowed to talk to the agent is not thereby allowed to approve
 * what it does, and a card in their DM sits unanswered until it expires
 * while the agent waits. Undefined = no home (the approver has no DM yet,
 * or the named link is not in this feed): the caller leaves the approval
 * unclaimed and a later poll retries. An older control plane never sends
 * the field: keep the legacy first-direct-link pick, so version skew
 * degrades to the old behavior rather than to silence.
 */
const approvalCardLink = (
  presence: AdapterPresence,
): AdapterLink | undefined => {
  const { approvalsLinkId, links } = presence;
  if (approvalsLinkId === undefined) {
    return links.find((l) => l.kind === "direct") ?? links[0];
  }
  if (approvalsLinkId === null) return undefined;
  return links.find((l) => l.id === approvalsLinkId);
};

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

  /** messageRef → the grouped card on it. A card of one is a group too (its
   * message is where the next same-task approval lands). */
  const groups = new Map<string, GroupCard>();

  const groupFor = (prompt: TrackedPrompt): GroupCard | undefined =>
    prompt.messageRef ? groups.get(prompt.messageRef) : undefined;

  /** A grouped card is RENDERED by the group path once it has held more
   * than one approval; a card of one keeps the classic single rendering. */
  const isMulti = (g: GroupCard): boolean => g.live.size + g.settled.length > 1;

  const renderGroupNow = async (g: GroupCard): Promise<void> => {
    const credential = tokenFor.get(g.presenceId);
    const cardUi = cardUiFor.get(g.presenceId);
    if (!credential || !cardUi?.renderGroup) {
      throw new Error("group card not renderable yet");
    }
    const ref = cardUi.unpackMessageRef(g.messageRef);
    if (!ref) throw new Error("group card ref malformed");
    const live = [...g.live.values()].filter(
      (a): a is PendingApproval => a !== null,
    );
    if (live.length !== g.live.size) {
      throw new Error("group card waiting on recovered details");
    }
    await cardUi.renderGroup({
      credential,
      channel: ref.channel,
      ts: ref.ts,
      view: { live, settled: [...g.settled] },
    });
  };

  /** Render now, serialized behind any render in flight. Rejects on
   * failure so a settle can keep its prompts tracked. */
  const flushGroup = (g: GroupCard): Promise<void> => {
    if (g.timer) {
      clearTimeout(g.timer);
      g.timer = null;
    }
    const run = g.chain.then(() => renderGroupNow(g));
    g.chain = run.catch(() => {});
    return run;
  };

  const scheduleGroupRender = (g: GroupCard): void => {
    if (g.timer) return;
    g.timer = setTimeout(() => {
      g.timer = null;
      flushGroup(g).catch((err: unknown) =>
        deps.onLog("group card render failed; next change retries", {
          err: String(err),
        }),
      );
    }, deps.groupDebounceMs ?? 2_000);
    g.timer.unref?.();
  };

  const outcomeOf = (
    state: "decided" | "expired",
    text: string,
  ): GroupOutcome =>
    state === "expired"
      ? "expired"
      : text.startsWith("✅")
        ? "approved"
        : text.startsWith("⛔")
          ? "denied"
          : "decided";

  /** A row as its card's done list records it. */
  const settledRow = (
    id: string,
    prompt: TrackedPrompt,
    approval: PendingApproval | null,
    outcome: GroupOutcome,
    by?: string,
  ): GroupCardView["settled"][number] => ({
    id,
    title: prompt.title ?? approval?.summary?.action ?? null,
    ...(approval?.batch?.label && { label: approval.batch.label }),
    outcome,
    ...(by && { by }),
  });

  /** Stop tracking a prompt and drop it from its card's live rows, so a
   * later render of that card never offers (or Approve-alls) an id that is
   * already settled. The card itself is not rewritten here. */
  const untrack = (prompt: TrackedPrompt): void => {
    prompts.delete(prompt.approvalId);
    const g = groupFor(prompt);
    if (!g) return;
    g.live.delete(prompt.approvalId);
    if (g.live.size === 0) groups.delete(g.messageRef);
  };

  /**
   * Settle several prompts at once, card first: every grouped member is
   * moved to its card's done list, each touched card renders ONCE, and only
   * then does the ledger settle. A failed render puts the members back and
   * keeps them tracked (the caller's cadence retries), the same contract
   * `settleTracked` keeps for a single card.
   */
  const settleMany = async (
    list: TrackedPrompt[],
    state: "decided" | "expired",
    text: string,
  ): Promise<void> => {
    const byGroup = new Map<GroupCard, TrackedPrompt[]>();
    for (const prompt of list) {
      const g = groupFor(prompt);
      if (g && isMulti(g)) {
        const members = byGroup.get(g) ?? [];
        members.push(prompt);
        byGroup.set(g, members);
        continue;
      }
      try {
        if (await settleTracked(prompt, state, text)) untrack(prompt);
      } catch (err) {
        deps.onLog("settle failed; will retry", { err: String(err) });
      }
    }
    for (const [g, members] of byGroup) {
      const removed = members.map((p) => ({
        prompt: p,
        approval: g.live.get(p.approvalId) ?? null,
      }));
      for (const { prompt, approval } of removed) {
        g.live.delete(prompt.approvalId);
        g.settled.push(
          settledRow(
            prompt.approvalId,
            prompt,
            approval,
            outcomeOf(state, text),
          ),
        );
      }
      try {
        await flushGroup(g);
      } catch (err) {
        // Put them back: the card still shows them live, so they must stay
        // tracked and live until a render lands.
        const ids = new Set(members.map((p) => p.approvalId));
        g.settled = g.settled.filter((s) => !ids.has(s.id));
        for (const { prompt, approval } of removed) {
          g.live.set(prompt.approvalId, approval);
        }
        deps.onLog("group settle render failed; will retry", {
          err: String(err),
        });
        continue;
      }
      for (const prompt of members) {
        try {
          await deps.controlPlane.settlePrompt(prompt.approvalId, state);
          prompts.delete(prompt.approvalId);
        } catch (err) {
          deps.onLog("ledger settle failed; will retry", { err: String(err) });
        }
      }
      if (g.live.size === 0) groups.delete(g.messageRef);
    }
  };

  /** Join a new approval to its task's open card on this presence, if one
   * in `externalThreadId` (the card home right now) can take it; returns
   * that card. */
  const openGroupFor = (
    presenceId: string,
    externalThreadId: string,
    approval: PendingApproval,
  ): GroupCard | undefined => {
    if (!cardUiFor.get(presenceId)?.renderGroup) return undefined;
    if (!APPROVAL_GROUP_ID_RE.test(approval.id)) return undefined;
    const key = approvalGroupKey(approval);
    for (const g of groups.values()) {
      if (g.presenceId !== presenceId || g.key !== key) continue;
      if (g.externalThreadId !== externalThreadId) continue;
      // A card carries at most one click's worth of ids (the shared group
      // decide cap); the next arrival opens a fresh card.
      if (g.live.size === 0 || g.live.size >= APPROVAL_GROUP_MAX_IDS) continue;
      if (![...g.live.keys()].every((id) => APPROVAL_GROUP_ID_RE.test(id))) {
        continue;
      }
      return g;
    }
    return undefined;
  };

  /**
   * Card FIRST, ledger second, untrack last: once the ledger settles, no
   * instance ever looks at this prompt again, so settling before the rewrite
   * lands strands a live-looking card (missing credential during boot,
   * instance death between the two calls). Any failure keeps the prompt
   * tracked — the caller's cadence (the 5s sweep, or the poll loop's next
   * absence) retries the whole pair; a missing credential (config feed
   * pending) just leaves it tracked the same way. Resolves true once the
   * card and the ledger are both settled.
   */
  const settleTracked = async (
    prompt: TrackedPrompt,
    state: "decided" | "expired",
    text: string,
  ): Promise<boolean> => {
    if (prompt.messageRef) {
      const credential = tokenFor.get(prompt.presenceId);
      const cardUi = cardUiFor.get(prompt.presenceId);
      if (!credential || !cardUi) return false;
      const ref = cardUi.unpackMessageRef(prompt.messageRef);
      if (!ref) return false;
      await cardUi.settle({
        credential,
        ...ref,
        text,
        title: prompt.title,
      });
    }
    await deps.controlPlane.settlePrompt(prompt.approvalId, state);
    return true;
  };

  /**
   * The candidates the control plane's ledger still holds pending; the rest
   * are untracked here without a rewrite.
   *
   * A click on the events (HTTP) arm is decided control-plane-side: it
   * rewrites THAT card itself (response_url) and settles the ledger, and
   * this adapter is never told. Without this check the absence arm then
   * rewrote the person's own decision as "Decided from the dashboard", or
   * as "Expired" once the deadline passed (live, 2026-10-03). The ledger is
   * the one record every channel decide path settles (a dashboard decision
   * goes straight to the gateway and leaves it pending, so it still gets
   * its dashboard rewrite).
   *
   * A decision in flight on THIS channel keeps its prompt: settleDecided
   * owns that rewrite. A failed lookup acts on nothing; everything stays
   * tracked and the caller's cadence retries.
   *
   * On a GROUPED card, a row settled that way moves to the card's done
   * list and the card re-renders, because a one-row (or partly failed)
   * events-arm click leaves the shared card to this adapter. A card left
   * with no live rows is not rendered: the control plane replaced it
   * itself when one click decided all of it.
   */
  const stillUnsettled = async (
    candidates: TrackedPrompt[],
  ): Promise<TrackedPrompt[]> => {
    if (candidates.length === 0) return [];
    let unsettled: Set<string>;
    try {
      unsettled = new Set(
        (await deps.controlPlane.listUnsettledPrompts()).map(
          (prompt) => prompt.approvalId,
        ),
      );
    } catch (err) {
      deps.onLog("unsettled-card lookup failed; will retry", {
        err: String(err),
      });
      return [];
    }
    const touched = new Set<GroupCard>();
    const keep = candidates.filter((prompt) => {
      if (unsettled.has(prompt.approvalId)) return true;
      if (deciding.has(prompt.approvalId)) return false;
      // Grouped-ness is the card's BEFORE this row leaves it: a two-row
      // card losing one row is still a grouped card.
      const g = groupFor(prompt);
      const grouped = g !== undefined && isMulti(g);
      const approval = g?.live.get(prompt.approvalId) ?? null;
      untrack(prompt);
      if (g && grouped) {
        g.settled.push(
          settledRow(prompt.approvalId, prompt, approval, "decided"),
        );
        touched.add(g);
      }
      return false;
    });
    for (const g of touched) if (g.live.size > 0) scheduleGroupRender(g);
    return keep;
  };

  const settleExpired = async (): Promise<void> => {
    const now = Date.now();
    const expired = [...prompts.values()].filter(
      (prompt) => prompt.expiresAt !== null && prompt.expiresAt <= now,
    );
    const due = await stillUnsettled(expired);
    if (due.length === 0) return;
    await settleMany(due, "expired", "Expired (no response) · denied");
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
    if (!credential || !cardUi || !prompt.messageRef) return;
    const ref = cardUi.unpackMessageRef(prompt.messageRef);
    if (!ref) return;
    try {
      await cardUi.settle({
        credential,
        ...ref,
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
    if (!prompt) return;
    const g = groupFor(prompt);
    if (g && isMulti(g)) {
      await settleDecidedMany([approvalId], {
        outcome: outcomeOf("decided", text),
      });
      return;
    }
    untrack(prompt);
    await settleCardSafe(prompt, text);
  };

  /** A grouped click's outcome (socket arm): the decided ids move to their
   * card's done list in one render. The ledger is already settled by the
   * control plane's decide; a failed render is cosmetic here (the next
   * poll's absence arm would otherwise re-settle), so the ids untrack. */
  const settleDecidedMany = async (
    approvalIds: string[],
    outcome: { outcome: GroupOutcome; by?: string },
  ): Promise<void> => {
    const touched = new Set<GroupCard>();
    for (const id of approvalIds) {
      const prompt = prompts.get(id);
      if (!prompt) continue;
      prompts.delete(id);
      const g = groupFor(prompt);
      if (!g) continue;
      const approval = g.live.get(id) ?? null;
      g.live.delete(id);
      g.settled.push(
        settledRow(id, prompt, approval, outcome.outcome, outcome.by),
      );
      touched.add(g);
    }
    for (const g of touched) {
      try {
        await flushGroup(g);
      } catch (err) {
        deps.onLog("group card update failed", { err: String(err) });
      }
      if (g.live.size === 0) groups.delete(g.messageRef);
    }
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

    const link = approvalCardLink(presence);
    if (!link) return;
    const decode = deps.threadAddressOf(presence);
    if (!decode) return;
    const target = replyTargetForLink(decode, link);

    const claimed = await deps.controlPlane.claimPrompt({
      approvalId: approval.id,
      presenceId,
      externalThreadId: link.externalThreadId,
      expiresAt: approval.expiresAt ?? null,
    });
    if (!claimed) return;

    const track = (messageRef: string) =>
      prompts.set(approval.id, {
        approvalId: approval.id,
        presenceId,
        messageRef,
        externalThreadId: link.externalThreadId,
        expiresAt: approval.expiresAt
          ? new Date(approval.expiresAt).getTime()
          : null,
        title: approval.summary?.action ?? null,
      });

    // Same task, card still open in this home → this approval joins THAT
    // message: the ledger row shares its ref (restart-safe), and the card
    // re-renders once the burst settles down.
    const open = openGroupFor(presenceId, link.externalThreadId, approval);
    if (open) {
      await deps.controlPlane.recordPromptMessage(approval.id, open.messageRef);
      open.live.set(approval.id, approval);
      track(open.messageRef);
      scheduleGroupRender(open);
      return;
    }

    const posted = await cardUi.post({
      credential,
      channel: target.channel,
      ...(target.threadTs && { threadTs: target.threadTs }),
      ...(presence.agent.imageUrl && { iconUrl: presence.agent.imageUrl }),
      approval,
    });
    const messageRef = cardUi.packMessageRef(posted);
    await deps.controlPlane.recordPromptMessage(approval.id, messageRef);
    track(messageRef);
    if (cardUi.renderGroup) {
      groups.set(messageRef, {
        presenceId,
        key: approvalGroupKey(approval),
        messageRef,
        externalThreadId: link.externalThreadId,
        live: new Map([[approval.id, approval]]),
        settled: [],
        timer: null,
        chain: Promise.resolve(),
      });
    }
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
          // next poll retries the pair. A card a channel click already
          // settled is untracked instead (`stillUnsettled`).
          const pendingIds = new Set(pending.map((a) => a.id));
          // Recovered group members get their details from this poll. Once
          // a rebuilt card has every row's details it renders again: a join
          // whose debounced render was lost to a restart shows up then.
          const filled = new Set<GroupCard>();
          for (const approval of pending) {
            const tracked = prompts.get(approval.id);
            const g = tracked ? groupFor(tracked) : undefined;
            if (g && g.live.get(approval.id) === null) {
              g.live.set(approval.id, approval);
              g.key ??= approvalGroupKey(approval);
              filled.add(g);
            }
          }
          for (const g of filled) {
            const complete = [...g.live.values()].every((a) => a !== null);
            if (complete && isMulti(g)) scheduleGroupRender(g);
          }
          const absent = [...prompts.values()].filter(
            (prompt) =>
              prompt.presenceId === presenceId &&
              !pendingIds.has(prompt.approvalId) &&
              // A click on THIS card is mid-flight: decide() already removed
              // the approval from the pending set, and settleDecided is
              // about to rewrite the card with the real outcome. An absence
              // settle here would win the race with the wrong provenance.
              !deciding.has(prompt.approvalId),
          );
          const nearDeadline: TrackedPrompt[] = [];
          const decidedElsewhere: TrackedPrompt[] = [];
          for (const prompt of await stillUnsettled(absent)) {
            if (
              prompt.expiresAt !== null &&
              prompt.expiresAt - 15_000 <= Date.now()
            ) {
              // At/near the deadline: expire NOW rather than waiting out the
              // sweep against a local clock the gateway already beat.
              nearDeadline.push(prompt);
              continue;
            }
            decidedElsewhere.push(prompt);
          }
          if (nearDeadline.length > 0) {
            await settleMany(
              nearDeadline,
              "expired",
              "Expired (no response) · denied",
            );
          }
          if (decidedElsewhere.length > 0) {
            await settleMany(
              decidedElsewhere,
              "decided",
              "Decided from the dashboard",
            );
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
        // The ref stays PACKED here: it is provider-opaque, and the
        // presence's own card UI decodes it at settle time (the only moment
        // the provider is guaranteed known — this sweep can run before the
        // presence is owned here). A row with no recorded message has no
        // card to rewrite; it is tracked for expiry only.
        prompts.set(prompt.approvalId, {
          approvalId: prompt.approvalId,
          presenceId: prompt.agentChannelId,
          messageRef: prompt.externalMessageRef,
          externalThreadId: prompt.externalThreadId,
          // The gateway's own recorded deadline, so a fast restart never marks
          // a still-live approval timed-out early. A row with no recorded
          // expiry (older) gets one sweep cycle to settle.
          expiresAt: prompt.expiresAt
            ? new Date(prompt.expiresAt).getTime()
            : Date.now() + 5_000,
          title: null,
        });
      }
      // Rebuild grouped cards: ledger rows sharing one message ref are one
      // card. Details arrive with the next poll (live entries start null).
      const byRef = new Map<string, TrackedPrompt[]>();
      for (const prompt of prompts.values()) {
        if (!prompt.messageRef || groups.has(prompt.messageRef)) continue;
        const members = byRef.get(prompt.messageRef) ?? [];
        members.push(prompt);
        byRef.set(prompt.messageRef, members);
      }
      // The task key comes from the first poll that carries a row's details.
      for (const [messageRef, members] of byRef) {
        const [first] = members;
        if (!first) continue;
        groups.set(messageRef, {
          presenceId: first.presenceId,
          key: null,
          messageRef,
          externalThreadId: first.externalThreadId,
          live: new Map(members.map((p) => [p.approvalId, null])),
          settled: [],
          timer: null,
          chain: Promise.resolve(),
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
    settleDecidedMany,

    stop(): void {
      for (const g of groups.values()) if (g.timer) clearTimeout(g.timer);
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
