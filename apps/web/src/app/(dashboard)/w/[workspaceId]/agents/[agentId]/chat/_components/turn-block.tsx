"use client";

import { LIFECYCLE_TURN_ERROR_CODES } from "@onecli/api/validations/conversation";
import { Bubble, BubbleContent } from "@onecli/ui/components/bubble";
import { Message, MessageContent } from "@onecli/ui/components/message";
import type { Turn } from "@/lib/api/types";
import type { RenderedTurn } from "@/lib/chat/transcript";
import {
  isActiveTurn,
  isAutomationTurn,
  isJoiningTurn,
} from "@/lib/chat/turns";
import { AutomationTurnHeader } from "./automation-turn";
import { ChatMarkdown } from "./chat-markdown";
import { ConnectorSuggestions } from "./connect-suggestions";
import { ToolCallRow } from "./tool-call-row";
import { TurnNotice } from "./turn-notice";
import { UserBubble } from "./user-bubble";

/**
 * One turn: what was asked, what the agent did, what came back.
 *
 * A turn can fail with NO transcript event (the agent restarted, or the turn
 * hit its time limit) — `turn.error` from the turns poll is the only witness,
 * which is why the error line prefers it over the folded one.
 */

const waitingCopy = (turn: Turn): string =>
  turn.status === "queued" || turn.status === "dispatched"
    ? "Waking the agent…"
    : "Thinking…";

/** Named doors get a proper label; an unrecognized one still says where it
 *  came from rather than nothing. "web" is home — no chip. */
const ORIGIN_LABELS: Record<string, string> = { slack: "via Slack" };

/** Turn.errorCode values that mean "a platform hiccup, not agent output" —
 *  rendered as the quiet TurnNotice, never the red failure box (the copy
 *  already says what to do; red would say the agent is broken). Derived from
 *  the API's own registry (the same client-safe module the composer reads
 *  TURN_MESSAGE_MAX_LENGTH from), so a new lifecycle code reaches this
 *  branch without a hand-synced copy; an unknown code still safely falls
 *  back to the red box. */
const FRIENDLY_FAILURE_CODES = new Set<string>(LIFECYCLE_TURN_ERROR_CODES);

/** Turn.errorCode values whose fix is a link away on the agent's Models
 *  page, with the label saying WHICH fix: no key at all vs a key the
 *  provider refused. Keyed on the CODE, never the message text — and a Map,
 *  not a bare object, so a peer-supplied string can never resolve to a
 *  prototype member. */
const KEY_FIX_LABELS = new Map<string, string>([
  ["no_model_key", "Connect a model key"],
  ["model_provider_error", "Check the model key"],
  // The free trial credit ran out — same family, sharper verb: there is no
  // user key to check, the fix is adding one.
  ["trial_credit_exhausted", "Add your own model key"],
]);

const originLabel = (source: string): string | undefined =>
  source === "web" ? undefined : (ORIGIN_LABELS[source] ?? `via ${source}`);

export const TurnBlock = ({
  turn,
  rendered,
  followUps,
  modelsHref,
  onConnectModelKey,
}: {
  turn: Turn;
  rendered: RenderedTurn | undefined;
  /** Mid-run follow-ups riding THIS turn (`joining`/`joined`), oldest first.
   *  Rendered between the user bubble and the agent block, so the answer
   *  that covers them stays the LAST thing in the exchange. */
  followUps?: Turn[];
  /** Where "Connect a model key" goes; omitted outside the agent page. */
  modelsHref?: string;
  /** Open the add-key dialog IN PLACE (preferred over the Models link when
   *  provided): the fix happens over the chat instead of leaving it. */
  onConnectModelKey?: () => void;
}) => {
  const active = isActiveTurn(turn);
  // The transcript stream's raw `error` event lands a beat before the turns
  // poll flips the status and delivers the canonical error + errorCode. While
  // the poll still says ACTIVE, showing the stream's raw text would flash the
  // red blob and then swap to the friendly notice — so an active turn keeps
  // its waiting state and the error renders only from the settled poll view.
  const errorText = turn.error ?? (active ? undefined : rendered?.error);
  const showWaiting = active && (rendered?.tools.length ?? 0) === 0;
  // A turn the reader can fix from the Models page — no key yet, or a key
  // the provider refused. Rendered as guidance with the fix attached, rather
  // than as a failure.
  const keyFixLabel = KEY_FIX_LABELS.get(turn.errorCode ?? "");
  // A lifecycle hiccup (restart, start failure, capacity): guidance too,
  // just with no action to attach — the sentence itself says what to do.
  const friendlyFailure = FRIENDLY_FAILURE_CODES.has(turn.errorCode ?? "");

  return (
    <>
      {isAutomationTurn(turn) ? (
        // A platform-posted cron/watch report — `turn.message` is the
        // platform's header, not the person's words, so it gets a system label
        // (the report body renders in the agent-side block below), never a
        // user bubble.
        <AutomationTurnHeader source={turn.source} title={turn.message} />
      ) : (
        <UserBubble
          text={turn.message}
          origin={originLabel(turn.source)}
          conversationId={turn.conversationId}
          attachments={turn.attachments}
          // Only reachable standalone as the orphan fallback (a follow-up
          // whose target left the list) — grouped follow-ups render below.
          {...(isJoiningTurn(turn) && { hint: "Received, folding it in" })}
        />
      )}

      {followUps?.map((followUp) => (
        <UserBubble
          key={followUp.id}
          text={followUp.message}
          origin={originLabel(followUp.source)}
          conversationId={followUp.conversationId}
          attachments={followUp.attachments}
          // Steering into the live run: received, being folded into the
          // answer below. The hint drops once the run consumes it (`joined`)
          // — the quiet mark's whole lifetime is the in-between.
          {...(isJoiningTurn(followUp) && {
            hint: "Received, folding it in",
          })}
        />
      ))}

      {(rendered || active || errorText || turn.status === "aborted") && (
        <Message align="start">
          <MessageContent className="min-w-0">
            {rendered && rendered.tools.length > 0 && (
              <div className="flex flex-col">
                {rendered.tools.map((tool, index) => (
                  <ToolCallRow
                    // callId can be empty on an orphaned finish — fall back
                    // to the position so keys stay unique.
                    key={tool.callId || `${tool.name}-${index}`}
                    tool={tool}
                    turnEnded={!active}
                  />
                ))}
              </div>
            )}
            {rendered?.text ? (
              <>
                <Bubble variant="ghost">
                  <BubbleContent>
                    <ChatMarkdown text={rendered.text} suppressConnectLinks />
                  </BubbleContent>
                </Bubble>
                {/* Connect links in the answer render as the card below it —
                    icon + description + Connect — instead of prose links
                    (suppressed above): one unmissable call to action. */}
                <ConnectorSuggestions text={rendered.text} />
              </>
            ) : showWaiting ? (
              <p className="text-muted-foreground animate-pulse text-sm">
                {waitingCopy(turn)}
              </p>
            ) : null}
            {rendered?.notices.map((notice, index) => (
              <TurnNotice key={`${index}-${notice}`} message={notice} />
            ))}
            {errorText &&
              (keyFixLabel ? (
                <TurnNotice
                  message={errorText}
                  {...((turn.errorCode === "no_model_key" ||
                    turn.errorCode === "trial_credit_exhausted") &&
                  onConnectModelKey
                    ? {
                        action: {
                          onClick: onConnectModelKey,
                          label: keyFixLabel,
                        },
                      }
                    : modelsHref && {
                        action: { href: modelsHref, label: keyFixLabel },
                      })}
                />
              ) : friendlyFailure ? (
                <TurnNotice message={errorText} />
              ) : (
                <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs">
                  {errorText}
                </p>
              ))}
            {turn.status === "aborted" && !errorText && (
              <p className="text-muted-foreground text-xs italic">Stopped.</p>
            )}
          </MessageContent>
        </Message>
      )}
    </>
  );
};
