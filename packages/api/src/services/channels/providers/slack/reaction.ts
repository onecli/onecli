import { cleanLabel, NO_REPLY_TOKEN } from "@onecli/agent-protocol/text";

/**
 * What a person's emoji reaction on the agent's own message tells the
 * agent. Pure, so the copy and the emoji reading are pinned by unit tests;
 * the door (`ingestReaction` in ./dispatch) decides whether the reaction
 * reaches the agent at all.
 */

/** Slack's names for a plain yes / no. Several are aliases of one emoji
 * (`+1` is what the picker sends, `thumbsup` what an API client may). */
const YES_REACTIONS: ReadonlySet<string> = new Set([
  "+1",
  "thumbsup",
  "white_check_mark",
  "heavy_check_mark",
  "ok_hand",
]);
const NO_REACTIONS: ReadonlySet<string> = new Set([
  "-1",
  "thumbsdown",
  "x",
  "no_entry",
  "no_entry_sign",
]);

/** How much of the reacted message the note quotes: enough to tell which
 * question was answered, never the whole message. */
const QUOTE_MAX = 200;

/**
 * Slack names a toned emoji `<name>::skin-tone-<2..6>` (a picker reaction
 * carries the person's default tone), so the tone is dropped before the
 * name is read: a toned thumbs up is still a yes.
 */
const baseEmoji = (reaction: string): string =>
  reaction.replace(/::skin-tone-\d$/, "");

/** The emoji read as a plain yes / no, by its base name. */
const meaningOf = (name: string): string => {
  if (YES_REACTIONS.has(name)) return " (read as: yes / approved)";
  if (NO_REACTIONS.has(name)) return " (read as: no / declined)";
  return "";
};

/**
 * The note the agent receives. Written as the person's own words (it rides
 * the same door a typed message does, under their name). The quote is the
 * agent's own message, clamped to its first line: people may react to a
 * long answer, and the note only needs to say which one. Both inserts are
 * cleaned (control and format characters out), since a custom emoji name
 * and the quoted text are workspace-controlled.
 */
export const reactionNote = (reaction: string, quoted: string): string => {
  const name = baseEmoji(reaction);
  const firstLine = cleanLabel(quoted.split("\n", 1)[0] ?? "", QUOTE_MAX);
  return (
    `[Reaction] I reacted :${cleanLabel(name)}:${meaningOf(name)} ` +
    `to your message: "${firstLine}". If you asked me something, treat this ` +
    `as my answer. Otherwise it is just an acknowledgement: answer exactly ` +
    `${NO_REPLY_TOKEN} unless a reply is really needed.`
  );
};
