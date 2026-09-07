/**
 * Slack text-shaping helpers shared by every card renderer — the api's reach
 * cards and the adapter's approval cards clamp the same Slack limits, and a
 * drifted copy is how one of them silently starts posting cards Slack
 * refuses (`invalid_blocks` kills the whole message, which for an approval
 * card means a silent approval).
 *
 * Escape first, clamp after: escaping expands (`&` → `&amp;` is ×5), so a
 * pre-escape clamp can still blow a block's budget.
 */

/**
 * Make untrusted text inert in Slack `mrkdwn`/`markdown_text`: `<`, `>`, `&`
 * are the ONLY characters Slack treats as syntax openers, and `<!channel>`,
 * `<!here>`, `<@U…>` are live directives — a prompt-injected agent could
 * mass-ping a workspace through its own answer. Every untrusted string
 * (model output, tool output, notices) passes through here before entering
 * ANY Slack payload, in the api's events arm and the adapter alike — which
 * is why the one definition lives in the shared package. (Moved from
 * agent-protocol: every consumer was Slack-shaped, and this file is the
 * Slack text layer it belongs to.)
 */
export const escapeSlackText = (raw: string): string =>
  raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Slack header blocks cap plain_text at 150 chars — clamp with room for a
 * short "… · " template prefix. */
export const clampHeader = (value: string): string =>
  value.length <= 120 ? value : `${value.slice(0, 120)}…`;

/** One escaped dynamic field inside a section (Slack section cap: 3,000).
 * A torn trailing entity under the ellipsis renders as its literal chars —
 * harmless in already-escaped text. */
export const clampLabel = (value: string): string =>
  value.length <= 200 ? value : `${value.slice(0, 200)}…`;

/** Line terminators that would escape a `>` blockquote continuation, or arm
 * multiline anchors mid-line — normalized to `\n` first. */
export const normalizeLines = (value: string): string =>
  value.replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n");

/**
 * The user-mention token — Slack's `<@U…>` directive
 * (https://docs.slack.dev/messaging/formatting-message-text/).
 *
 * The SEED of the formatting layer: today the repo only needs to build the
 * token (matching a bot mention in inbound text) — the full parse/render
 * pass over Slack's directive grammar (`<#C…>`, `<!channel>`, `<url|label>`,
 * date formatting) lands here when the inbound decoder and the outbound
 * mention resolver are built. One home, so the grammar never forks.
 *
 * TRUST: composing a mention makes a LIVE ping. Callers must only ever pass
 * ids the PLATFORM resolved (`escapeSlackText` exists precisely so model
 * output cannot forge one) — never text a model authored.
 */
export const userMentionToken = (userId: string): string => `<@${userId}>`;

// ── Inbound token decoding ───────────────────────────────────────────────────

/**
 * Resolve a user id to a display name — the one lookup `decodeSlackTokens`
 * cannot do itself. Callers own WHERE names come from (the ingestion door
 * resolves linked users to their PLATFORM name and strangers via the
 * provider API); null = leave the token as-is (fail open per token).
 */
export type MentionNameResolver = (
  userId: string,
) => Promise<string | null> | string | null;

/** Resolve a channel id to its name — needed because live Slack sends
 * LABEL-LESS `<#C…>` refs (observed on private channels in the live walk;
 * the docs' conversations.info is for exactly this). Null = leave raw. */
export type ChannelNameResolver = (
  channelId: string,
) => Promise<string | null> | string | null;

/** Bound the per-message lookup work: a hostile message packed with unique
 * mention tokens must not become a users.info flood. Beyond the cap, tokens
 * stay raw — a comprehension gap, never an outage. */
const MAX_MENTION_LOOKUPS = 20;

/**
 * Decode Slack's inbound token grammar into text a model can READ —
 * the exact retrieval-parsing algorithm from
 * https://docs.slack.dev/messaging/formatting-message-text/ ("Notes on
 * retrieving formatted messages"):
 *
 *   1. every `<(.*?)>` substring is a token;
 *   2. `#C…`            → channel link   → `#name` (label inline; a bare
 *                          `<#C123>` keeps its id — still better than `<>`s);
 *   3. `@U…` / `@W…`    → user mention   → `@[Name]` via the resolver — the
 *                          OUTBOUND grammar, so the transcript teaches the
 *                          form the write side resolves (the
 *                          `|label` variant is accepted but NEVER trusted —
 *                          usernames-in-mentions were deprecated in 2017 and
 *                          the label can be stale or forged; the id is
 *                          resolved regardless, label the fallback);
 *   4. `!subteam^S…`    → group mention  → `@group-label` (label inline);
 *   5. `!here|!channel|!everyone`        → `@here` etc. (literal);
 *      `!date^…|fallback`                → the fallback text (it exists for
 *                          exactly this: clients that cannot render);
 *   6. anything else    → URL link       → `label (url)` or the bare url.
 *
 * WHY: the model otherwise sees `<@U0B0WPLS8MC>` and cannot know who that
 * is — it pattern-matches the token, stores broken habits, and cannot even
 * recognize its OWN name in `<@UBOT>`. Decoded names are attacker-chosen
 * display text, so every dynamic field is cleaned (control chars stripped,
 * clamped) before it enters the model's context.
 *
 * Fail-open per token: anything unresolvable or unrecognized stays verbatim.
 * A decoding gap is a comprehension gap; a throw here would kill the turn.
 */
export const decodeSlackTokens = async (
  text: string,
  resolveUserName: MentionNameResolver,
  resolveChannelName?: ChannelNameResolver,
): Promise<string> => {
  const tokenRe = /<(.*?)>/g;
  const matches = [...text.matchAll(tokenRe)];
  if (matches.length === 0) return text;

  // Resolve unique user ids first (dedup + cap), so a repeated mention
  // costs one lookup and the flood cap is on PEOPLE, not occurrences.
  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const m of matches) {
    const inner = m[1] ?? "";
    const user = /^@([UW][A-Z0-9]{2,})(?:\|.*)?$/.exec(inner);
    if (user?.[1] && userIds.size < MAX_MENTION_LOOKUPS) userIds.add(user[1]);
    // Label-less channel refs need a lookup; labeled ones decode inline.
    const channel = /^#(C[A-Z0-9]{2,})$/.exec(inner);
    if (
      channel?.[1] &&
      resolveChannelName &&
      channelIds.size < MAX_MENTION_LOOKUPS
    ) {
      channelIds.add(channel[1]);
    }
  }
  const names = new Map<string, string>();
  for (const id of userIds) {
    const name = await resolveUserName(id);
    if (name) names.set(id, cleanDecodedName(name));
  }
  const channelNames = new Map<string, string>();
  for (const id of channelIds) {
    const name = await resolveChannelName?.(id);
    if (name) channelNames.set(id, cleanDecodedName(name.replace(/^#/, "")));
  }

  return text.replace(tokenRe, (token, innerRaw: string) => {
    const inner = innerRaw ?? "";

    // 3. user mention (label accepted, never trusted) — decoded to the
    // OUTBOUND mention grammar `@[Name]`, not plain `@Name`, on purpose:
    // the model writes mentions by imitating its transcript, so the read
    // side must show exactly the form the write side resolves (the live
    // walk proved plain decodes teach plain habits that ping nobody).
    // Groups and broadcasts stay plain — they are not writable mentions.
    const user = /^@([UW][A-Z0-9]{2,})(?:\|(.*))?$/.exec(inner);
    if (user?.[1]) {
      const resolved = names.get(user[1]);
      if (resolved) return `@[${resolved}]`;
      const label = user[2] ? cleanDecodedName(user[2]) : null;
      return label ? `@[${label}]` : token;
    }

    // 2. channel link: inline label first, resolver for the label-less
    // form live Slack actually sends. An UNRESOLVABLE ref (a private
    // channel the bot is not in - conversations.info answers
    // channel_not_found, mirroring Slack's own "private channel"
    // placeholder for non-members) decodes to a readable marker carrying
    // the id: the model can say "a channel I can't see" and the id is
    // still there for anything that needs it. A raw <#C…> would read as
    // noise (the live walk proved exactly this).
    const channel = /^#(C[A-Z0-9]{2,})(?:\|(.*))?$/.exec(inner);
    if (channel?.[1]) {
      const label = channel[2] ? cleanDecodedName(channel[2]) : null;
      if (label) return `#${label}`;
      const resolved = channelNames.get(channel[1]);
      if (resolved) return `#${resolved}`;
      return resolveChannelName ? `#[private channel ${channel[1]}]` : token;
    }

    // 4. user-group mention.
    const group = /^!subteam\^(S[A-Z0-9]{2,})(?:\|(.*))?$/.exec(inner);
    if (group) {
      const label = group[2] ? cleanDecodedName(group[2]) : null;
      return label ? `@${label.replace(/^@/, "")}` : token;
    }

    // 5. special mentions + date formatting.
    const special = /^!(here|channel|everyone)(?:\|.*)?$/.exec(inner);
    if (special) return `@${special[1]}`;
    const date = /^!date\^.*\|(.*)$/.exec(inner);
    if (date?.[1]) return cleanDecodedName(date[1]);

    // 6. URL link (label kept, url kept — both matter to a model).
    const link = /^(https?:\/\/[^|]+)\|(.*)$/.exec(inner);
    if (link?.[1] && link[2]) {
      return `${cleanDecodedName(link[2])} (${link[1]})`;
    }
    if (/^https?:\/\//.test(inner)) return inner;

    // Unrecognized: verbatim (mailto:, tel:, future grammar).
    return token;
  });
};

/** Clean one decoded dynamic field before it enters model context: strip
 * control characters, fold newlines (a name must never fabricate a line),
 * strip angle brackets (a display name of literally "<@U999>" or
 * "<!channel>" must not land in the model's context LOOKING like a real
 * token - the model cannot tell a decoded name from live grammar, so a
 * hostile profile name could fabricate a mention that never happened) and
 * square brackets (they ARE the outbound mention grammar `@[Name]` the
 * decode emits - a name of literally "x] @[admin" must not break out of
 * its brackets and fabricate a second mention), clamp. Same posture as the
 * ingestion door's speaker-prefix cleaning. */
const cleanDecodedName = (raw: string): string =>
  [...raw.replace(/[\r\n]+/g, " ")]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return (
        code >= 0x20 &&
        code !== 0x7f &&
        ch !== "<" &&
        ch !== ">" &&
        ch !== "[" &&
        ch !== "]"
      );
    })
    .join("")
    .trim()
    .slice(0, 80);
