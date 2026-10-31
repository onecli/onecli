"use client";

import {
  TURN_FAILED_RAW_ERROR_MESSAGE,
  isRawErrorPayload,
} from "@onecli/api/validations/conversation";
import { activityForTool } from "@onecli/agent-protocol/activity";
import { Message, MessageContent } from "@onecli/ui/components/message";
import type { Turn } from "@/lib/api/types";
import type { RenderedTurn } from "@/lib/chat/transcript";
import {
  isActiveTurn,
  isAddKeyCode,
  isAutomationTurn,
  isJoinedTurn,
  isJoiningTurn,
  isPlatformAuthoredTurn,
} from "@/lib/chat/turns";
import { AgentAnswer } from "./agent-answer";
import { AutomationTurnHeader } from "./automation-turn";
import { ActivityLine } from "./activity-line";
import { FollowUpExchange } from "./follow-up-exchange";
import { GreetingActions } from "./greeting-actions";
import { NarrationText } from "./narration-text";
import { AttachmentChips } from "./attachment-chips";
import { originLabel } from "./origin-label";
import { ToolGroup } from "./tool-group";
import { connectLinkTextFromTools } from "@/lib/chat/connect-links";
import { TurnNotice, type TurnNoticeAction } from "./turn-notice";
import { UserBubble } from "./user-bubble";
import { SkillImportCard } from "./skill-import-card";
import { isSkillImportTool, parseSkillImport } from "@/lib/chat/skill-import";

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

/** Turn.errorCode values whose fix is a link away on the agent's Models
 *  page, with the label saying WHICH fix: no key at all, a key the provider
 *  refused, a key the workspace holds that this agent was not given, or a
 *  key it holds whose saved value could not be read.
 *  Keyed on the CODE, never the message text, and a Map, not a bare
 *  object, so a peer-supplied string can never resolve to a prototype
 *  member. */
const KEY_FIX_LABELS = new Map<string, string>([
  ["no_model_key", "Connect a model key"],
  ["model_provider_error", "Check the model key"],
  // The free trial credit ran out — same family, sharper verb: there is no
  // user key to check, the fix is adding one.
  ["trial_credit_exhausted", "Add your own model key"],
  // The key exists; it is attached on the same Models page, so this one
  // always navigates (the in-place dialog ADDS a key, which is not the fix).
  ["model_key_not_attached", "Attach the key"],
  // The agent holds the key but its saved value could not be read: it is
  // re-entered on the same page (never the add-key dialog either).
  ["model_key_unreadable", "Re-enter the key"],
]);

export const TurnBlock = ({
  turn,
  rendered,
  followUps,
  followUpRendered,
  modelsHref,
  onOpenComputer,
  computerHref,
  onConnectModelKey,
}: {
  turn: Turn;
  rendered: RenderedTurn | undefined;
  /** Mid-run follow-ups riding THIS turn (`joining`/`joined`), oldest first.
   *  A JOINED one (the run has it) renders between the user bubble and the
   *  agent block with the agent's reply to it, so the answer that covers
   *  the rest stays the LAST thing in the exchange. A JOINING one (sent,
   *  not yet read) renders BELOW the agent's live work: it is a message
   *  the agent has not reached yet, so it sits after what the agent is
   *  doing now, and moves up into the exchange the moment it is picked
   *  up. */
  followUps?: Turn[];
  /** What the transcript holds under each follow-up's own id: its reply,
   *  streaming or stored. */
  followUpRendered?: (followUpId: string) => RenderedTurn | undefined;
  /** Where "Connect a model key" goes; omitted outside the agent page. */
  modelsHref?: string;
  /** Open the agent's screen IN PLACE for its "Needs you" desktop ask, over
   *  the conversation with Take control in view. Preferred over the deep
   *  link when present. */
  onOpenComputer?: (requestId: string) => void;
  /** Deep link fallback. Without either action the notice is plain text. */
  computerHref?: (requestId: string) => string;
  /** Open the add-key dialog IN PLACE (preferred over the Models link when
   *  provided): the fix happens over the chat instead of leaving it. */
  onConnectModelKey?: () => void;
}) => {
  const active = isActiveTurn(turn);
  const joined = followUps?.filter(isJoinedTurn) ?? [];
  const joining = followUps?.filter(isJoiningTurn) ?? [];
  // SEND NOW has a run to act on only once the turn is
  // RUNNING, and helps only while it is inside a tool (a step with no
  // result yet). A message with files joins the live run like any other
  // (the rare runner that cannot carry files there is refused by the API,
  // and the click says so).
  const toolRunning =
    rendered?.tools.some((tool) => tool.output === undefined) === true &&
    !rendered.ended;
  const sendNowFor = (followUp: Turn) =>
    turn.status === "running"
      ? { toolRunning, outcome: followUpRendered?.(followUp.id)?.sentNow }
      : undefined;
  // One turn, two speakers' files: what the person attached rides under
  // their bubble; what the agent sent back (send_file) rides under its
  // answer. Split on `direction` — an older API omits it, and every such
  // row is the person's.
  const inboundAttachments = turn.attachments.filter(
    (attachment) => attachment.direction !== "outbound",
  );
  const outboundAttachments = turn.attachments.filter(
    (attachment) => attachment.direction === "outbound",
  );
  // The transcript stream's raw `error` event lands a beat before the turns
  // poll flips the status and delivers the canonical error + errorCode. While
  // the poll still says ACTIVE, showing the stream's raw text would flash it
  // and then swap to the canonical notice, so an active turn keeps its
  // waiting state and the error renders only from the settled poll view.
  const errorText = turn.error ?? (active ? undefined : rendered?.error);
  // WORKING vs SETTLED. While the turn runs and no durable answer exists,
  // the agent block is a live WORK LOG, Claude-style: the agent's opening
  // sentence (its plan, written for the reader), then every tool call folded
  // into ONE collapsible run header, then the sentence still being written.
  // The narration and the tail are deliberately styled as transient: they
  // will not survive the turn (history carries no deltas, so a refresh
  // never shows them either). The moment the answer lands, the block
  // SETTLES to the record: the run header and the markdown answer, exactly
  // what a late joiner gets.
  const working = active && !rendered?.text;
  // The run header times the whole turn, from when it started to the answer.
  const startedAt = turn.startedAt ?? turn.createdAt;
  // The live caption: what the agent is doing right now. Shown while it is
  // NOT talking — when narration is streaming, the words themselves are the
  // better signal, and a caption above a growing sentence reads as clutter.
  // Falls back to the lifecycle copy before the agent reports any activity
  // (waking a sandbox can take a moment, and a blank row reads as broken).
  const activityText = working
    ? (rendered?.activity ?? waitingCopy(turn))
    : undefined;
  // The tail only counts when it has visible words: a model emitting a bare
  // newline before its first tool call must not blank the caption row.
  const liveTail = rendered?.liveText.trim() ? rendered.liveText : "";
  const showActivity = Boolean(activityText) && !liveTail;
  // Once the run header is on screen it already says which tool is running
  // ("Running a command · 12s"), so a caption naming that same tool would
  // repeat it on screen. The caption still SPEAKS it (sr-only): its polite
  // announcer is the one live progress cue a screen-reader user gets.
  const lastTool = rendered?.tools.at(-1);
  const captionRepeatsHeader =
    lastTool !== undefined && activityText === activityForTool(lastTool.name);
  // EVERY failure renders as a notice, never a red failure box: each
  // sentence on this surface already says what to do next, and none is a
  // crash the reader caused. What varies is the action and the details.
  //
  // The fix the code names, when it is a link away on the Models page. The
  // in-place add-key dialog applies only when the fix is ADDING a key.
  const keyFixLabel = KEY_FIX_LABELS.get(turn.errorCode ?? "");
  const keyFix: TurnNoticeAction | undefined = keyFixLabel
    ? isAddKeyCode(turn.errorCode) && onConnectModelKey
      ? { onClick: onConnectModelKey, label: keyFixLabel }
      : modelsHref
        ? { href: modelsHref, label: keyFixLabel }
        : undefined
    : undefined;
  // An uncoded failure whose text is a provider's raw response body, not a
  // sentence (a coded one always carries the control plane's canonical
  // copy): the reader gets the generic line. A readable sentence is shown as
  // written.
  const rawPayload = Boolean(errorText && isRawErrorPayload(errorText));
  const noticeText = rawPayload ? TURN_FAILED_RAW_ERROR_MESSAGE : errorText;
  // The raw text behind the notice, one click away for whoever is
  // debugging: the payload the generic line replaced, or, under a coded
  // failure's canonical copy, the transcript's error event (a policy
  // refusal names its rule there).
  const rawDetails = rawPayload
    ? errorText
    : turn.errorCode && rendered?.error && rendered.error !== errorText
      ? rendered.error
      : undefined;

  return (
    <>
      {isPlatformAuthoredTurn(turn) ? (
        // A platform-posted row — `turn.message` is the platform's own text
        // (a cron/watch header, or the greeting instruction), not the
        // person's words, so it never gets a user bubble. Only automations
        // get a HEADER: the greeting's instruction is plumbing, and a
        // caption over the agent's first words would give the trick away.
        isAutomationTurn(turn) ? (
          <AutomationTurnHeader source={turn.source} title={turn.message} />
        ) : null
      ) : (
        <UserBubble
          text={turn.message}
          origin={originLabel(turn.source)}
          conversationId={turn.conversationId}
          attachments={inboundAttachments}
          // Only reachable standalone as the orphan fallback (a follow-up
          // whose target left the list) — grouped follow-ups render below.
          {...(isJoiningTurn(turn) && { hint: "Received, folding it in" })}
        />
      )}

      {joined.map((followUp) => (
        <FollowUpExchange
          key={followUp.id}
          followUp={followUp}
          rendered={followUpRendered?.(followUp.id)}
          targetActive={active}
        />
      ))}

      {(rendered ||
        active ||
        errorText ||
        turn.status === "aborted" ||
        outboundAttachments.length > 0) && (
        <Message align="start">
          <MessageContent className="min-w-0">
            {working ? (
              // THE WORK LOG: what is happening, as it happens. Narration is
              // untrusted mid-turn model text — rendered as plain text by
              // NarrationText, never markdown. `aria-live` stays off here:
              // announcing every delta would read the whole log to a
              // screen-reader user token by token (the ActivityLine below
              // keeps its own polite announcer).
              <div className="flex flex-col gap-1.5">
                {rendered?.lead ? <NarrationText text={rendered.lead} /> : null}
                {rendered && rendered.tools.length > 0 && (
                  <ToolGroup
                    tools={rendered.tools}
                    turnEnded={false}
                    startedAt={startedAt}
                  />
                )}
                {liveTail ? <NarrationText text={liveTail} live /> : null}
                {showActivity && activityText && (
                  <ActivityLine
                    text={activityText}
                    visuallyHidden={captionRepeatsHeader}
                  />
                )}
              </div>
            ) : (
              // SETTLED: the record. The run header first, then the answer:
              // the same shape a reader who joined late gets from
              // history, so what you watched and what you reload agree.
              <>
                {rendered && rendered.tools.length > 0 && (
                  <ToolGroup
                    tools={rendered.tools}
                    turnEnded={!active}
                    startedAt={startedAt}
                  />
                )}
                {rendered?.text ? (
                  <AgentAnswer
                    text={rendered.text}
                    toolConnectLinks={connectLinkTextFromTools(rendered.tools)}
                  />
                ) : null}
                {/* What a skill import did, under the reply: built from the
                    import tool's own result, one card per import call. */}
                {!active &&
                  rendered?.tools
                    .filter((tool) => isSkillImportTool(tool.name))
                    .map((tool) => {
                      const data = parseSkillImport(tool.output);
                      return data ? (
                        <SkillImportCard key={tool.callId} data={data} />
                      ) : null;
                    })}
              </>
            )}
            {/* THE AGENT'S FILES (send_file), under its answer: the same
                chips the person's files get, mirrored to the agent's side.
                They come from the turns poll (refetched at turn.done), not
                the stream — bytes never ride a transcript. Rendered while
                the turn is still working too: a file sent mid-turn is
                already downloadable. */}
            {outboundAttachments.length > 0 && (
              <div className="flex flex-col gap-1">
                {outboundAttachments.some((a) => a.caption) && (
                  <p className="text-muted-foreground text-xs">
                    {outboundAttachments
                      .map((a) => a.caption)
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                <AttachmentChips
                  conversationId={turn.conversationId}
                  attachments={outboundAttachments}
                  align="start"
                />
              </div>
            )}
            {rendered?.notices.map((notice, index) => {
              // The agent's open ask for a person on its screen: the one
              // notice with somewhere to go. Settled asks are plain lines.
              const ask = rendered.desktopRequests.get(index);
              const open =
                ask?.outcome === "pending"
                  ? onOpenComputer
                    ? {
                        onClick: () => onOpenComputer(ask.id),
                        label: "Open computer",
                      }
                    : computerHref
                      ? { href: computerHref(ask.id), label: "Open computer" }
                      : undefined
                  : undefined;
              return (
                <TurnNotice
                  key={`${index}-${notice}`}
                  message={notice}
                  action={open}
                />
              );
            })}
            {noticeText && (
              <TurnNotice
                message={noticeText}
                action={keyFix}
                details={rawDetails}
              />
            )}
            {turn.status === "aborted" && !errorText && (
              <p className="text-muted-foreground text-xs italic">Stopped.</p>
            )}
            {/* Under the onboarding agent's first message, the first step
                it just pointed at, one click each. Only once the greeting
                settles (its words land first, the card follows), and under
                a greeting that failed too: the agent could not speak, but
                connecting Gmail is still the first thing to do. */}
            {turn.source === "greeting" && !active && <GreetingActions />}
          </MessageContent>
        </Message>
      )}

      {/* Sent while the agent worked, not read yet: below the live work,
          where a message the agent has not reached belongs. Nothing under
          it until the run picks it up and it moves into the exchange, but
          its status line may offer SEND NOW (and then say what happened,
          the answer folded under its own id). */}
      {joining.map((followUp) => (
        <FollowUpExchange
          key={followUp.id}
          followUp={followUp}
          sendNow={sendNowFor(followUp)}
        />
      ))}
    </>
  );
};
