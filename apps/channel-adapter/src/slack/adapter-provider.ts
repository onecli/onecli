import { escapeSlackText, type AdapterPresence } from "@onecli/agent-protocol";
import type {
  ChannelAdapterProvider,
  ProviderOutcomeContext,
  ProviderTransport,
  ProviderTransportHandlers,
} from "../providers";
import { slackApprovalCardUi } from "./approval-card";
import { postMessage } from "./client";
import { botTokenOf } from "./credentials";
import { slackMirrorPosts } from "./mirror-posts";
import { openSocketMode } from "./socket-mode";

/**
 * Slack's `ChannelAdapterProvider`: the one module that binds every
 * Slack-shaped seam — credentials, Socket Mode, outcome posts, decision
 * rendering, mirror posts, and approval cards — into the shape the
 * orchestrator (adapter.ts) consumes. Nothing outside src/slack/ imports a
 * Slack module directly; the registry in ../providers hands this object out.
 */

/** The app-level token beside `botTokenOf`'s bot token — only slack/ modules
 * know the credential JSON's shape. Socket Mode dials with THIS token; posts
 * use the bot token. */
const appTokenOf = (presence: AdapterPresence): string | null => {
  if (!presence.credentialsJson) return null;
  try {
    const parsed = JSON.parse(presence.credentialsJson) as {
      appToken?: string;
    };
    return parsed.appToken ?? null;
  } catch {
    return null;
  }
};

/** The approval-card click, parsed out of a raw interactivity payload. Only
 * our two buttons translate — every other block_actions surface is not ours
 * and returns null. The click carries ONLY the opaque approval id in its
 * value (the injection rule); the clicker's id rides along for the control
 * plane's authorization check. */
const approvalDecisionOf = (
  payload: Record<string, unknown>,
): {
  approvalId: string;
  decision: "approve" | "deny";
  clickerExternalUserId: string;
} | null => {
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
    return null;
  }
  return {
    approvalId: action.value,
    decision: action.action_id === "channel_approve" ? "approve" : "deny",
    clickerExternalUserId: clicker,
  };
};

/** The reach card's click, same trust shape (see the api-side renderer,
 * reach-card.ts: action ids `reach_approve` / `reach_members` / `reach_block`,
 * value = the opaque grant id). Kept as literals here - the adapter is a
 * separate deployable and the wire vocabulary is pinned by the control
 * plane's route tests. `reach_deny` is the pre-rename id for members_only,
 * still honored so cards posted before the third button settle. */
const DECISIONS: Record<string, "approved" | "members_only" | "blocked"> = {
  reach_approve: "approved",
  reach_members: "members_only",
  reach_block: "blocked",
  reach_deny: "members_only",
};

const reachDecisionOf = (
  payload: Record<string, unknown>,
): {
  grantId: string;
  decision: "approved" | "members_only" | "blocked";
  clickerExternalUserId: string;
} | null => {
  const typed = payload as {
    type?: string;
    user?: { id?: string };
    actions?: { action_id?: string; value?: string }[];
  };
  const action = typed.actions?.[0];
  const clicker = typed.user?.id;
  const decision = DECISIONS[action?.action_id ?? ""];
  if (
    typed.type !== "block_actions" ||
    !action?.value ||
    !clicker ||
    !decision
  ) {
    return null;
  }
  return {
    grantId: action.value,
    decision,
    clickerExternalUserId: clicker,
  };
};

const openTransport = (
  presence: AdapterPresence,
  handlers: ProviderTransportHandlers,
): ProviderTransport | null => {
  const appToken = appTokenOf(presence);
  if (!appToken) {
    handlers.onLog("socket presence without app token", {
      presenceId: presence.presenceId,
    });
    return null;
  }
  return openSocketMode(
    { appToken },
    {
      onEvent: handlers.onEvent,
      onInteractive: (payload) => {
        const decision = approvalDecisionOf(payload);
        if (decision) {
          handlers.onApprovalDecision(decision);
          return;
        }
        const reach = reachDecisionOf(payload);
        if (reach) handlers.onReachDecision(reach);
      },
      onPermanentFailure: handlers.onPermanentFailure,
      onLog: (message, detail) =>
        handlers.onLog(`socket(${presence.agent.name}): ${message}`, detail),
    },
  );
};

const respondToOutcome = async ({
  credential,
  iconUrl,
  outcome,
  onLog,
}: ProviderOutcomeContext): Promise<void> => {
  if (outcome.kind === "invite") {
    if (outcome.outcome === "refuse" && outcome.channel) {
      if (outcome.message) {
        await postMessage(credential, {
          channel: outcome.channel,
          text: escapeSlackText(outcome.message),
          ...(iconUrl && { iconUrl }),
        }).catch((err: unknown) => onLog("refusal post failed", { err }));
      }
      // Slack's door never asks to leave (exiting needs channel-manage
      // scopes — see the control plane's refuse-and-stay-muted decision);
      // the wire field stays for a provider whose exit costs nothing.
      if (outcome.leave) {
        onLog("leave requested but no provider exit is implemented", {
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
    postMessage(credential, {
      channel: reply.channel,
      text,
      ...(reply.threadTs && { threadTs: reply.threadTs }),
      ...(iconUrl && { iconUrl }),
    }).catch((err: unknown) => onLog("reply post failed", { err }));

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

const decisionSettledText: ChannelAdapterProvider["decisionSettledText"] = ({
  decision,
  result,
}) =>
  result.kind === "decided"
    ? `${decision === "approve" ? "✅ Approved" : "⛔ Denied"} by ${escapeSlackText(result.decidedByName)}`
    : result.kind === "already_settled"
      ? "This request was already decided."
      : escapeSlackText(result.message);

export const slackAdapterProvider: ChannelAdapterProvider = {
  credentialOf: botTokenOf,
  openTransport,
  respondToOutcome,
  decisionSettledText,
  posts: slackMirrorPosts,
  cardUi: slackApprovalCardUi,
};
