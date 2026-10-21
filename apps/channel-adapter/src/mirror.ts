import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  type AdapterReplyItem,
  type AdapterWorkItem,
} from "@onecli/agent-protocol";
// The client-safe app catalog (pure data, no Node builtins at import) — the
// card gate below must agree with the web's isCardConnectLink.
import { getApp } from "@onecli/api/apps/registry";
// The one definition of "automated turn" and its predicate, shared with the
// control plane's continuity bridge, so a new automation source lands in both
// in one edit.
import {
  GREETING_SOURCE,
  TURN_FAILED_PARTIAL_MESSAGE,
  TURN_FAILED_RAW_ERROR_MESSAGE,
  TURN_FAILED_SILENT_MESSAGE,
  TURN_STOPPED_MESSAGE,
  isAutomationSource,
  isRawErrorPayload,
  type AutomationSource,
} from "@onecli/api/validations/conversation";
import { mentionNamesOf, plainMentionCandidatesOf } from "@onecli/channels";
import type { AdapterMentionReportRequest } from "@onecli/agent-protocol";
import { isNoReply } from "@onecli/agent-protocol/text";
import { ControlPlaneError, type ControlPlaneClient } from "./control-plane";
import {
  replyTargetForTurn,
  type ChannelPostTarget,
  type ThreadAddressDecoder,
} from "./targets";

/**
 * The gateway's "connect this app" dashboard links, recognized in an answer
 * so the channel can render them as a card with a button: the web chat's
 * ConnectorSuggestions, translated to the channel's native blocks. Three
 * shapes (the ones of `parseConnectLink`'s shapes this card can act on):
 * - `…/agents/<id>/connections?attach=<provider>`: connected, but turned off
 *   for this agent (`access_restricted`, which also offers a connect link for
 *   the same app; the attach row wins, see `cardLinks`)
 * - `…/connections?connect=<provider>…`: nothing connected yet
 * - `…/connections/apps/<provider>`: connected, not attached to this agent
 *   (the same answer when the gateway knows no agent)
 *
 * The app page also carries two refusals whose fix is NOT an attach:
 * `?reconnect=<id>` (the saved login was rejected) and `?org_access=<org>`
 * (a GitHub organization refused the account). An Attach card would send
 * the user to the wrong dialog, so those links stay in the prose, where
 * they open the app page that walks through the actual fix.
 */
// The prefix is LAZY: greedy would swallow across two adjacent URLs (the
// `](` between a markdown label's link and its target is in the allowed
// class) and merge them into one match, losing the first provider's card.
// Each arm consumes a trailing query/fragment so span surgery lifts the
// WHOLE url — otherwise `…/apps/gmail?src=x` would card gmail and leave a
// dangling `?src=x` in the prose.
const CONNECT_LINK_RE =
  /https?:\/\/[^\s<>|]+?(?:\/agents\/[^\s<>|/?#]+\/connections\?(?:[^\s<>|]*&)?attach=([a-z0-9-]{1,64})(?![\w-])(?:&[^\s<>|]*)?(?:#[^\s<>|]*)?|\/connections(?:\?(?:[^\s<>|]*&)?connect=([a-z0-9-]{1,64})(?![\w-])(?:&[^\s<>|]*)?(?:#[^\s<>|]*)?|\/apps\/([a-z0-9-]{1,64})(?![\w/-])(?:[?#][^\s<>|]*)?))/g;

export interface ConnectLink {
  url: string;
  provider: string;
  kind: "connect" | "attach";
}

/** Slack rejects a message over 50 blocks and each card row costs two, so a
 * runaway answer must not sink the whole post — links past the cap simply
 * stay in the prose. */
const MAX_CONNECT_CARDS = 10;

/** A match carries its span so carded links can be lifted out of the prose
 * exactly — substring surgery would also bite a longer URL that happens to
 * share a carded one as a prefix (`connect=google` inside
 * `connect=google-drive`). */
interface ConnectLinkMatch extends ConnectLink {
  start: number;
  end: number;
}

/** App-page parameters that name a refusal an Attach card cannot fix. */
const NON_ATTACH_PARAMS = ["reconnect", "org_access"] as const;

const namesNonAttachRefusal = (url: string): boolean => {
  try {
    const { searchParams } = new URL(url);
    return NON_ATTACH_PARAMS.some((param) => searchParams.has(param));
  } catch {
    return false;
  }
};

/** Every connect-link occurrence in the answer, in order, with spans. */
const findConnectLinkMatches = (answer: string): ConnectLinkMatch[] => {
  const matches: ConnectLinkMatch[] = [];
  for (const match of answer.matchAll(CONNECT_LINK_RE)) {
    const [, agentAttach, connect, appPage] = match;
    const provider = agentAttach ?? connect ?? appPage;
    if (!provider) continue;
    // Shed trailing punctuation the model may have glued on.
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    const kind = connect ? "connect" : "attach";
    if (appPage && namesNonAttachRefusal(url)) continue;
    let start = match.index;
    let end = match.index + url.length;
    // A markdown-form link ("[label](url)") is lifted out whole — removing
    // just the URL would leave a broken "[label]()" in the prose.
    const head = answer.slice(Math.max(0, start - 220), start);
    const wrapper = /\[[^\n[\]]{0,200}\]\($/.exec(head);
    if (wrapper && answer[end] === ")") {
      start -= head.length - wrapper.index;
      end += 1;
    }
    matches.push({
      url,
      provider,
      kind,
      start,
      end,
    });
  }
  return matches;
};

/** The card rows: one per provider, capped. A provider's first link decides
 * its row, except that an attach link replaces a connect link: the
 * `access_restricted` answer offers both for one app, and switching the
 * existing account on is the fix it leads with. */
const cardLinks = (matches: ConnectLinkMatch[]): ConnectLink[] => {
  const links: ConnectLink[] = [];
  for (const { url, provider, kind } of matches) {
    // The web's isCardConnectLink law: only catalog apps get carded. A card
    // for a model-invented provider would strip the user's only real link
    // from the prose and assert a connection state as official UI (spoofed
    // favicon included) — an unknown id keeps its raw link instead.
    if (!getApp(provider)) continue;
    const seen = links.findIndex((link) => link.provider === provider);
    if (seen >= 0) {
      if (links[seen]?.kind === "connect" && kind === "attach") {
        links[seen] = { url, provider, kind };
      }
      continue;
    }
    if (links.length >= MAX_CONNECT_CARDS) continue;
    links.push({ url, provider, kind });
  }
  return links;
};

/** The answer with every occurrence of a carded provider's link removed by
 * exact span; links past the card cap stay put. A link that stood alone on
 * its line also takes its colon-terminated lead-in with it ("To reconnect,
 * open this link:"), which would otherwise dangle in front of nothing: the
 * card right below already says what to do. */
const proseWithoutCardedLinks = (
  answer: string,
  matches: ConnectLinkMatch[],
  carded: ReadonlySet<string>,
): string => {
  let prose = "";
  let cursor = 0;
  // The line break owed where a lifted line was, written only once more
  // text follows: two adjacent lifts must not stack blank lines, and a lift
  // at either end of the answer owes nothing.
  let owed = "";
  const append = (text: string) => {
    if (!text) return;
    if (prose && owed) prose += owed;
    owed = "";
    prose += text;
  };
  for (const match of matches) {
    if (!carded.has(match.provider)) continue;
    // A wrapper-rewound span (a connect link nested inside another link's
    // markdown label) can start BEFORE the previous match's end; the
    // backwards slice is empty, so nothing duplicates — at worst a label
    // fragment of the model's own nesting stays behind.
    const lifted = liftedLine(answer, cursor, match);
    if (!lifted) {
      append(answer.slice(cursor, match.start));
      cursor = Math.max(cursor, match.end);
      continue;
    }
    // The lifted line takes its own blank lines with it, trimmed at THIS
    // splice only, so the model's spacing elsewhere (code blocks included)
    // is untouched. The break it owes matches what surrounded it: a blank
    // line on either side keeps a paragraph break, a plain line break (a
    // list, a tight block) keeps just that.
    const before = answer.slice(cursor, lifted.start);
    const kept = dropDanglingLeadIn(before).trimEnd();
    append(kept);
    const paragraph =
      BLANK_LINE.test(before.slice(kept.length)) ||
      BLANK_LINE.test(answer.slice(match.end, lifted.resume));
    owed = owed === "\n\n" || paragraph ? "\n\n" : "\n";
    cursor = Math.max(cursor, lifted.resume);
  }
  append(answer.slice(cursor));
  return prose.trim();
};

/** A line holding only whitespace, between two line breaks. */
const BLANK_LINE = /\n[ \t\r]*\n/;

/** A line's markup ahead of a lifted link that holds nothing else:
 * blockquote markers and at most one bullet. It goes with the link instead
 * of staying behind as an empty bullet or quote line. Numbered markers stay
 * (dropping one would leave a gap in the list's numbering). */
const MARKUP_ONLY = /^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+)?$/;

/**
 * The span of a lifted link's line when the link stood alone on it (bare
 * bullet or quote markup ahead of it counts as alone): `start` is where the
 * line begins, `resume` is just past the blank lines after it, at the start
 * of the next content line so that line keeps its indentation (a nested
 * bullet, an indented block). Null when the link shares its line with
 * other text. `cursor` bounds the backwards look: text before it was
 * already spliced.
 */
const liftedLine = (
  answer: string,
  cursor: number,
  match: ConnectLinkMatch,
): { start: number; resume: number } | null => {
  const from = Math.max(cursor, match.start);
  let start = from;
  while (
    start > cursor &&
    from - start <= LINE_PREFIX_SPAN &&
    answer[start - 1] !== "\n"
  ) {
    start--;
  }
  if (start > 0 && answer[start - 1] !== "\n") return null;
  if (!MARKUP_ONLY.test(answer.slice(start, from))) return null;
  let end = match.end;
  while (end < answer.length && " \t\r".includes(answer[end]!)) end++;
  if (end < answer.length && answer[end] !== "\n") return null;
  let resume = end;
  for (let k = end; k < answer.length && " \t\r\n".includes(answer[k]!); k++) {
    if (answer[k] === "\n") resume = k + 1;
  }
  return { start, resume };
};

/** Words that make a colon-ended clause a pointer at the lifted link. */
const LEAD_IN_WORD = /\b(link|url|here|below|following)\b/i;

/** A clause that OPENS with a (re)connect imperative points at the lifted
 * connect link too ("Reconnect Salesforce:", "To connect Gmail:"). Only as
 * the opener: anywhere else the verb is usually a statement ("I couldn't
 * connect to it because:"), and dropping content is worse than leaving a
 * lead-in behind. */
const LEAD_IN_IMPERATIVE =
  /^(?:please\s+|to\s+)?(?:re)?(?:connect|authori[sz]e)\b/i;

/** A clause over a couple of lines' worth is prose, not a pointer. */
const MAX_LEAD_IN = 200;

/** How far back the clause scan looks: the longest clause plus room for
 * line markup. Bounded, so each call is O(1) however long the answer. */
const LEAD_IN_SCAN = MAX_LEAD_IN + 40;

/** Line-start markup ahead of a line's text: blockquote markers, then a
 * heading (group 1) or a list marker (group 2). Each marker needs trailing
 * whitespace, so `**bold`, `#tag` and `1.5` are text, not markup. */
const LINE_PREFIX =
  /^[ \t]*(?:>[ \t]*)*(?:(#{1,6}[ \t]+)|((?:[-*+]|\d{1,9}[.)])[ \t]+))?/;

/** Periods that end an abbreviation, not a sentence ("e.g. use this link:").
 * Only ones that never close a sentence: "etc." often does. */
const ABBREVIATIONS = new Set(["e.g", "i.e", "vs", "cf"]);

const endsAbbreviation = (text: string, dot: number): boolean => {
  let i = dot;
  while (i > 0 && dot - i < 4 && /[A-Za-z.]/.test(text[i - 1]!)) i--;
  return ABBREVIATIONS.has(text.slice(i, dot).toLowerCase());
};

/** Line-start markup is read from at most this many chars of a line. */
const LINE_PREFIX_SPAN = 40;

/** The start of the line holding `index`, when it is close enough that the
 * line's markup could reach it; -1 otherwise. */
const nearLineStart = (text: string, index: number): number => {
  for (let i = index; i >= 0 && index - i <= LINE_PREFIX_SPAN; i--) {
    if (i === 0 || text[i - 1] === "\n") return i;
  }
  return -1;
};

/**
 * Strip a trailing clause that only introduced the lifted link: the last
 * sentence of the preceding text when it ends in a colon (emphasis may
 * close after it: "**Click here:**") and points at the link ("open this
 * link:", "click here:", "Reconnect Salesforce:"). Anything else is left
 * alone: a colon-ended sentence about something other than the link is the
 * model's content, not scaffolding, and so is a list item (dropping one
 * would leave an empty bullet or renumber the list). A heading or quote
 * lead-in goes with its markup.
 *
 * A bounded backwards scan, no backtracking regex: this runs on model
 * output up to the mirror's 40k-char fence.
 */
export const dropDanglingLeadIn = (text: string): string => {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (
    end > 0 &&
    trimmed.length - end < 3 &&
    (trimmed[end - 1] === "*" || trimmed[end - 1] === "_")
  ) {
    end--;
  }
  if (trimmed[end - 1] !== ":") return text;
  const closing = trimmed.slice(end);
  // Walk back to the clause start: a line break, or a sentence terminator
  // followed by whitespace. Past the window the clause is too long anyway.
  const floor = Math.max(0, end - 1 - LEAD_IN_SCAN);
  let start = -1;
  let atLineStart = false;
  for (let i = end - 2; i >= floor; i--) {
    const ch = trimmed[i];
    if (ch === "\n") {
      start = i + 1;
      atLineStart = true;
      break;
    }
    if (
      (ch === "." || ch === "!" || ch === "?") &&
      /\s/.test(trimmed[i + 1] ?? "") &&
      !endsAbbreviation(trimmed, i)
    ) {
      start = i + 1;
      // A list marker's period ("1. Open the link:") is markup, not the
      // end of a sentence: the clause starts its line.
      const lineStart = nearLineStart(trimmed, i);
      if (
        lineStart !== -1 &&
        lineStart + linePrefix(trimmed, lineStart).length > i
      ) {
        start = lineStart;
        atLineStart = true;
      }
      break;
    }
  }
  if (start === -1) {
    if (floor > 0) return text;
    start = 0;
    atLineStart = true;
  }
  let contentStart = start;
  if (atLineStart) {
    const prefix = linePrefix(trimmed, start);
    if (prefix.list) return text;
    contentStart = start + prefix.length;
  }
  while (trimmed[contentStart] === " " || trimmed[contentStart] === "\t") {
    contentStart++;
  }
  const clause = trimmed.slice(contentStart, end);
  if (clause.length > MAX_LEAD_IN) return text;
  // Emphasis that closes after the colon must open inside the clause, or
  // dropping the clause would strand the other half of the pair.
  if (closing && !clause.includes(closing)) return text;
  // The pointer word must sit in the clause's LAST colon segment: "Here's
  // what happened: the token expired:" ends on a statement, not a pointer.
  // An opening "Here" presents what follows ("Here is what I found:"), so
  // only a later one counts ("click here:"); dropping content is worse than
  // leaving a lead-in behind.
  const segment = clause
    .slice(clause.lastIndexOf(":", clause.length - 2) + 1)
    .trimStart()
    .replace(/^[*_]+/, "");
  if (
    !LEAD_IN_WORD.test(segment.replace(/^here\b/i, "")) &&
    !LEAD_IN_IMPERATIVE.test(segment)
  ) {
    return text;
  }
  return trimmed.slice(0, start).trimEnd();
};

const linePrefix = (
  text: string,
  lineStart: number,
): { length: number; list: boolean } => {
  // A bounded slice keeps the match O(1) however long the line runs.
  const match = LINE_PREFIX.exec(
    text.slice(lineStart, lineStart + LINE_PREFIX_SPAN),
  );
  return { length: match?.[0].length ?? 0, list: match?.[2] !== undefined };
};

/** The catalog's own display name ("github" → "GitHub"); title-cased id as
 * the fallback for safety, though carded providers are always catalog
 * members. */
export const providerDisplayName = (provider: string): string =>
  getApp(provider)?.name ??
  provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");

/** Providers whose brand domain is not `<provider>.com`. Everything else
 * falls back to that guess — a wrong guess only costs the row its icon
 * (Google's favicon service serves a generic globe). */
const PROVIDER_DOMAINS: Record<string, string> = {
  gmail: "mail.google.com",
  "google-calendar": "calendar.google.com",
  "google-drive": "drive.google.com",
  "google-docs": "docs.google.com",
  "google-sheets": "sheets.google.com",
  "google-slides": "slides.google.com",
  "google-meet": "meet.google.com",
  "google-chat": "chat.google.com",
  "google-tasks": "tasks.google.com",
  "google-contacts": "contacts.google.com",
  "google-forms": "forms.google.com",
  "google-photos": "photos.google.com",
  "google-classroom": "classroom.google.com",
  "google-analytics": "analytics.google.com",
  "google-admin": "admin.google.com",
  "google-search-console": "search.google.com",
  "github-app": "github.com",
  "aws-role": "aws.amazon.com",
  aws: "aws.amazon.com",
  "microsoft-onenote": "onenote.com",
  "outlook-mail": "outlook.com",
  "outlook-calendar": "outlook.com",
  flyio: "fly.io",
  "jfrog-artifactory": "jfrog.com",
  "zoho-crm": "zoho.com",
  // Brand domains that live elsewhere — several `<id>.com` guesses below
  // belong to UNRELATED companies (linear.com, affinity.com, fathom.com),
  // and a third party's favicon on official UI is worse than a globe.
  jira: "www.atlassian.com",
  confluence: "www.atlassian.com",
  "vertex-ai": "cloud.google.com",
  "mongodb-atlas": "mongodb.com",
  datadog: "datadoghq.com",
  "microsoft-word": "microsoft.com",
  affinity: "affinity.co",
  sentry: "sentry.io",
  granola: "granola.ai",
  linear: "linear.app",
  fathom: "fathom.video",
  fireflies: "fireflies.ai",
  timeless: "timeless.day",
  circleback: "circleback.ai",
  pylon: "usepylon.com",
  pagerduty: "pagerduty.com",
  coralogix: "coralogix.com",
  onyx: "onyx.app",
  twilio: "twilio.com",
  dripify: "dripify.com",
};

/** The app's favicon via Google's resolver — Slack's image elements accept
 * only raster formats, and the catalog's own icons are SVGs. */
export const providerIconUrl = (provider: string): string => {
  const domain = PROVIDER_DOMAINS[provider] ?? `${provider}.com`;
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=128`;
};

/**
 * The COMPLETION PASS — the one and only answer path (the de-streaming
 * decision, recorded in the step-6 plan notes): every finished turn on a
 * linked conversation posts here, exactly once, on completion.
 *
 * - A PROVIDER-originated turn posts its answer (or its error — a door
 *   failure's `turn.error` IS the answer). The user's "seen" signal while it
 *   ran was the reaction receipt, which the control plane clears on this
 *   pass's winning claim.
 * - A WEB-originated turn is mirrored — question attributed, then the
 *   answer — so both doors of the same conversation stay visually in sync.
 *
 * Channel-general by design: this module decides WHAT to post and in what
 * order; every rendering decision (attribution formatting, icons, markdown
 * conversion, structured cards) lives behind the injected `MirrorPosts`
 * seam — Slack's implementation is slack/mirror-posts.ts.
 *
 * The cursor makes it exactly-once: the work poll only surfaces finished
 * turns past `mirrorCursor`, and the cursor advances by COMPARE-AND-SET —
 * an adapter twin (deploy overlap, a stale snapshot) loses the claim and
 * posts nothing.
 */

/** What the transcript holds for one finished turn: its answer, its
 * durable error, and the replies stored under the follow-ups it consumed. */
interface TranscriptOutcome {
  text: string | null;
  error: string | null;
  /** Follow-up id → the agent's reply to that message. */
  replies: ReadonlyMap<string, string>;
}

const transcriptOutcome = async (
  controlPlane: ControlPlaneClient,
  conversationId: string,
  turnId: string,
  followUpIds: readonly string[],
): Promise<TranscriptOutcome> => {
  let since: number | undefined;
  let text: string | null = null;
  // The turn's durable `error` event — the harness's terminal message. The
  // supervisor now sends it as `turn.result.error` on every failed turn, but
  // a turn closed by an older supervisor (or one whose report was lost) can
  // still hold `turn.error = NULL`, and this is then its only record. Last
  // one wins, matching the `text` semantics and the web's transcript fold.
  let error: string | null = null;
  // Same pass: a follow-up's reply is a `text` stored under its own id.
  const wanted = new Set(followUpIds);
  const replies = new Map<string, string>();
  for (let page = 0; page < 100; page += 1) {
    const history = await controlPlane.readTranscript(conversationId, since);
    for (const event of history.events) {
      const payload = (event.payload ?? {}) as {
        text?: string;
        message?: string;
      };
      if (event.turnId === turnId) {
        if (event.type === "text" && payload.text) text = payload.text;
        if (event.type === "error" && payload.message) error = payload.message;
      } else if (
        wanted.has(event.turnId) &&
        event.type === "text" &&
        payload.text
      ) {
        replies.set(event.turnId, payload.text);
      }
    }
    since = history.nextSince;
    if (!history.hasMore) break;
  }
  return { text, error, replies };
};

/**
 * A file the channel could not carry (bytes unreachable, or the upload
 * refused): its name, and the web door for it when the mirror has one (built
 * from the adapter's OWN config, never from anything the model or the
 * provider said). No `url` → the channel names the file and points at the web
 * in words.
 */
export interface UnavailableFile {
  name: string;
  url?: string;
}

/** One outbound file with its bytes in hand, ready for the channel. */
export interface OutboundFile {
  /** The platform's attachment id — what the web door is keyed by. */
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
  bytes: Uint8Array;
}

/**
 * The largest file the mirror will pull for a channel post — the platform's
 * own per-file cap, so the two can never disagree. Slack's ceiling is 1 GB;
 * this is the belt the control plane enforced at send time, re-stated here
 * so a control plane bug can never make the adapter buffer a gigabyte.
 */
export const MAX_MIRRORED_FILE_BYTES = MAX_OUTBOUND_ATTACHMENT_BYTES;

/**
 * What a channel must provide to carry the mirror's posts. Each operation is
 * semantic — the implementation owns the channel-native rendering (Slack:
 * slack/mirror-posts.ts); a second channel implements the same seam. The
 * shared `ChannelPostTarget` base (targets.ts) carries the credential and
 * thread address.
 */
export interface MirrorPosts {
  /** A person's words from another surface, attributed. `userName` null →
   * unnamed attribution. The message is a quote — never converted. */
  webSourced(
    input: ChannelPostTarget & { userName: string | null; message: string },
  ): Promise<void>;
  /** An automated run's report, or a peer task's report to the person (the
   * agent's own words after talking with another agent): the turn's title
   * as a caption, plus the body (model markdown) when one exists. */
  automation(
    input: ChannelPostTarget & {
      source: AutomationSource;
      title: string;
      body: string | null;
    },
  ): Promise<void>;
  /** The turn's answer — model-authored markdown (or a door failure's plain
   * `turn.error`). `mentions` is the resolved outbound-mention map
   * (normalized name → provider user id) for the channel renderer; absent =
   * render `@[Name]` tokens as literal text. */
  answer(
    input: ChannelPostTarget & {
      markdown: string;
      mentions?: ReadonlyMap<string, string>;
    },
  ): Promise<void>;
  /** An answer that carried connect links: the prose (links already removed)
   * plus one card row per app — name, attach-vs-connect intent line, and a
   * button whose `url` is pre-resolved by the mirror. `fullMarkdown` is the
   * untouched answer, for when the channel's own limits force the plain-post
   * degrade (the raw links must then stay visible in the prose). */
  connectCards(
    input: ChannelPostTarget & {
      markdown: string;
      links: ConnectLink[];
      fullMarkdown: string;
      mentions?: ReadonlyMap<string, string>;
    },
  ): Promise<void>;
  /** A no-model-key failure with the web's same call to action: the raw
   * answer (the canonical sentence) plus where the fix lives. */
  noModelKey(
    input: ChannelPostTarget & { modelsUrl: string; answer: string },
  ): Promise<void>;
  /** A model-provider refusal (usage limit, expired key) with the web's same
   * call to action: the canonical sentence plus where the key lives. */
  providerError(
    input: ChannelPostTarget & { modelsUrl: string; answer: string },
  ): Promise<void>;
  /** The free trial credit ran out — the no-model-key family with a sharper
   * verb (there is no user key to check; the person needs to ADD one). */
  trialCreditExhausted(
    input: ChannelPostTarget & { modelsUrl: string; answer: string },
  ): Promise<void>;
  /**
   * The agent's files for this turn (send_file), posted AFTER the answer as
   * ONE share: `files` carry bytes the mirror already pulled; `unavailable`
   * are files whose bytes could not be fetched (name only). The channel
   * decides how to say what it cannot carry — a missing upload scope, a
   * workspace that forbids uploads, a refused type — but it must always say
   * SOMETHING: a file the agent believes it sent must never vanish silently
   * (the web remains the complete record; `webLabel` names it).
   */
  files(
    input: ChannelPostTarget & {
      files: OutboundFile[];
      unavailable: UnavailableFile[];
      /** The web door by attachment id, for files the channel REFUSES after
       * the mirror handed it their bytes (missing scope, uploads disabled).
       * Same provenance rule as `unavailable[].url`. */
      attachmentUrl?: (attachmentId: string) => string;
    },
  ): Promise<void>;
  /** Platform chrome for a turn that ended without a normal answer — a
   * failure line, or the quiet "Stopped." after an abort. Rendered so it
   * cannot be mistaken for the agent's own voice. `warn` picks the failure
   * treatment over the muted one. */
  failureNotice(
    input: ChannelPostTarget & { message: string; warn: boolean },
  ): Promise<void>;
}

export interface MirrorDeps {
  controlPlane: ControlPlaneClient;
  /** The channel credential for this presence (opaque here). */
  credential: string;
  provider: string;
  posts: MirrorPosts;
  /** The provider's removal-detection seam (see ChannelAdapterProvider):
   * a post failure in → the provider's removal event, or null. */
  removalEventFor: (failure: unknown) => unknown | null;
  /** The provider's thread-address decoder (see targets.ts). */
  threadAddress: ThreadAddressDecoder;
  /** The agent's public avatar URL, threaded to every post when set. */
  iconUrl?: string | null;
  /** The link's cursor as this adapter last knew it (the CAS expectation). */
  knownCursor: string | null;
  item: AdapterWorkItem;
  /** Where a key-problem answer's call to action points (the agent's
   * Models page) — no_model_key and model_provider_error alike.
   * Omitted → plain text, no button. */
  modelsUrl?: string;
  /** The agent's chat page — connect-card buttons deep-link here with
   * `?attach=<provider>` so the web opens the attach dialog over the
   * conversation. Omitted → no card: a button hides its domain, so it must
   * never carry a model-authored URL; the answer posts unchanged with the
   * raw gateway link visible in the prose. */
  chatUrl?: string;
  /** The web download page for one of this turn's files, by attachment id —
   * the degrade line's link when the channel cannot carry the bytes. Built
   * by the adapter from `appUrl` + the agent's ids + this item's
   * conversation; the mirror only ever hands it an id. Omitted → the line
   * names the file and points at the web in words. */
  attachmentUrl?: (attachmentId: string) => string;
  onLog: (message: string, detail?: unknown) => void;
}

/**
 * The outbound-mention map for every piece of model text one mirror pass
 * posts (the turn's answer and its follow-ups' replies), in ONE resolve
 * call, plus the failures the next turn's context should learn about.
 *
 * `mentions` stays undefined when no text names anyone: the renderer then
 * prints `@[Name]` tokens as literal text, the pre-feature behavior.
 */
const resolveMentionsIn = async (
  deps: Pick<MirrorDeps, "controlPlane" | "onLog"> & {
    item: Pick<AdapterWorkItem, "presenceId" | "conversationId">;
  },
  texts: readonly (string | null)[],
): Promise<{
  mentions: ReadonlyMap<string, string> | undefined;
  failures: AdapterMentionReportRequest["failures"];
}> => {
  const said = texts.filter((text): text is string => Boolean(text));
  const names = [...new Set(said.flatMap(mentionNamesOf))];
  // NEAR-MISS candidates: plain `@name` prose runs. A candidate that
  // RESOLVES names a linked teammate the model addressed without the
  // grammar - it pinged nobody while reading like it worked, so it is
  // reported (the token path's failures are visible in the posted text;
  // this one is invisible without the report). Only resolve calls carry
  // them; they never enter the render map.
  const plainCandidates = [
    ...new Set(said.flatMap(plainMentionCandidatesOf)),
  ].filter((candidate) => !names.includes(candidate));
  if (names.length === 0 && plainCandidates.length === 0) {
    return { mentions: undefined, failures: [] };
  }
  try {
    const resolutions = await deps.controlPlane.resolveMentions(
      deps.item.presenceId,
      // One call, tokens first: the service caps at 20 and tokens are
      // the ones that must not lose their slot to prose candidates.
      [...names, ...plainCandidates].slice(0, 20),
      deps.item.conversationId,
    );
    const map = new Map<string, string>();
    const failures: AdapterMentionReportRequest["failures"] = [];
    const tokenNames = new Set(names);
    for (const resolution of resolutions) {
      if (resolution.kind === "resolved") {
        if (tokenNames.has(resolution.name)) {
          map.set(resolution.name, resolution.externalUserId);
        } else {
          // Plain prose named a real linked teammate: the near-miss.
          failures.push({ kind: "near_miss", name: resolution.name });
        }
      } else if (tokenNames.has(resolution.name)) {
        // Failures only matter for real tokens - an unresolvable
        // prose candidate ("@ symbol in a sentence") is noise.
        failures.push(
          resolution.kind === "ambiguous"
            ? {
                kind: "ambiguous",
                name: resolution.name,
                candidates: resolution.candidates,
              }
            : { kind: "unknown", name: resolution.name },
        );
      }
    }
    return { mentions: map, failures };
  } catch (err) {
    deps.onLog("mention resolve failed; posting degraded", { err });
    // Unresolved ≠ unknown: report nothing on an outage.
    return { mentions: new Map(), failures: [] };
  }
};

/**
 * Post one piece of the agent's own markdown (the turn's answer, or its
 * reply to a mid-turn message) the way the web renders it: connect links
 * as a card with a button, everything else as the plain answer.
 *
 * Card buttons are built only from the configured chat URL: a button hides
 * its domain, so it must never carry a model-authored URL. No chat URL (or
 * no links) → the plain answer, raw link visible in the prose. The 40k
 * ceiling matches mrkdwn's hostile-input fence and keeps the link scan's
 * worst case bounded, so a text past it posts plain.
 */
const postModelText = async (
  deps: Pick<MirrorDeps, "posts" | "chatUrl">,
  target: ChannelPostTarget,
  markdown: string,
  mentions: ReadonlyMap<string, string> | undefined,
): Promise<void> => {
  const chatUrl = deps.chatUrl;
  const matches =
    chatUrl && markdown.length <= 40_000
      ? findConnectLinkMatches(markdown)
      : [];
  const connectLinks = cardLinks(matches);
  if (chatUrl && connectLinks.length > 0) {
    const carded = new Set(connectLinks.map((link) => link.provider));
    // The adapter mints chatUrl query-free today, but the invariant
    // lives here, not at the construction site, so join accordingly.
    const sep = chatUrl.includes("?") ? "&" : "?";
    await deps.posts.connectCards({
      ...target,
      ...(mentions && { mentions }),
      markdown: proseWithoutCardedLinks(markdown, matches, carded),
      fullMarkdown: markdown,
      links: connectLinks.map((link) => ({
        ...link,
        // Deep-link into the chat's attach dialog over the conversation.
        url: `${chatUrl}${sep}attach=${encodeURIComponent(link.provider)}`,
      })),
    });
    return;
  }
  await deps.posts.answer({
    ...target,
    ...(mentions && { mentions }),
    markdown,
  });
};

/**
 * Handle one finished turn: post what the provider surface is missing, then
 * CAS the cursor. Returns the new cursor when this adapter won, or null when
 * a twin did (nothing was posted in that case).
 */
export const mirrorFinishedTurn = async (
  deps: MirrorDeps,
): Promise<string | null> => {
  const { item } = deps;
  /** Where a message's answer goes: the link's address, narrowed to the
   * thread that message was asked in when it was asked in one. */
  const targetFor = (asked: {
    sourceThreadId?: string | null;
  }): ChannelPostTarget => {
    const address = replyTargetForTurn(deps.threadAddress, item, asked);
    return {
      credential: deps.credential,
      channel: address.channel,
      ...(address.threadTs && { threadTs: address.threadTs }),
      ...(deps.iconUrl && { iconUrl: deps.iconUrl }),
    };
  };
  // The turn's own address when it has one (a DM thread), else the link's —
  // so an answer lands in the thread its question was asked in.
  const target = targetFor(item.turn);

  // Claim FIRST: the CAS is the exactly-once gate, so the post happens only
  // on the winning side. (Claim-then-post means a crash between the two can
  // drop one mirror post — the same at-most-once tradeoff the ingestion
  // doors document; a duplicate post to a human channel is worse than a
  // missing mirror of something the web already shows.) The turn id rides
  // along so the control plane clears the turn's reaction receipt on the
  // winning claim — the answer is about to post, so the "seen" comes off.
  const advanced = await deps.controlPlane.advanceCursor(
    item.linkId,
    deps.knownCursor,
    item.turn.createdAt,
    item.turn.id,
  );
  if (!advanced) return null;

  const fromProvider = item.turn.source === deps.provider;
  // An automated run's report (crons step 7, watches step 10): the turn is a
  // platform-materialized delivery whose message is the automation header,
  // not a person's question, and posting it as a web quote would attribute
  // automation to a human. One message: the report, or the header when the
  // run produced none. The icon distinguishes the two, and watch volume is
  // bounded by one-shot semantics (the decided answer to the posting-shape
  // question).
  const automated = isAutomationSource(item.turn.source)
    ? item.turn.source
    : null;

  try {
    const outcome = await transcriptOutcome(
      deps.controlPlane,
      item.conversationId,
      item.turn.id,
      (item.followUps ?? []).flatMap((followUp) =>
        followUp.id ? [followUp.id] : [],
      ),
    );
    /** A joined follow-up's reply, when the agent wrote one. A deliberate
     *  `[no reply]` is no reply at all here - nothing posts. */
    const replyTo = (followUp: { id?: string }): string | undefined => {
      const reply = followUp.id ? outcome.replies.get(followUp.id) : undefined;
      return isNoReply(reply) ? undefined : reply;
    };
    /** Claim a follow-up's reply for THIS post. True when there is a reply
     * and the claim won. An older control plane without the claim route
     * (404) never served the reply early either, so the pre-feed behavior
     * holds and this pass posts it; any other failure posts NOTHING: the
     * claim is the only thing standing between this pass and a reply feed
     * poll that may already have posted, and a missing reply the person
     * can still read on the web beats a duplicate in their thread. */
    const claimReplyOf = async (followUp: {
      id?: string;
    }): Promise<boolean> => {
      if (!followUp.id || replyTo(followUp) === undefined) return false;
      try {
        return await deps.controlPlane.claimReply(followUp.id);
      } catch (err) {
        if (err instanceof ControlPlaneError && err.status === 404) {
          return true;
        }
        deps.onLog("reply claim failed at close; reply not posted", {
          err: String(err),
          followUpId: followUp.id,
        });
        return false;
      }
    };
    // Precedence mirrors the web (turn-block prefers `turn.error`): the
    // agent's own text first; then the canonical/raw `turn.error`; then the
    // transcript's durable error event for old or missing terminal reports.
    // An error that is a provider's raw response body posts as the generic
    // failure line instead (the web folds the raw text away; a shared
    // channel has no place for it at all).
    const error = item.turn.error ?? outcome.error;
    // The agent chose to stay silent (a point-of-contact channel): post
    // nothing for the answer. Only a SUCCESSFUL silence - a failed turn whose
    // text happens to read "[no reply]" still reports its failure.
    const silent = isNoReply(outcome.text) && item.turn.status !== "failed";
    const answer = silent
      ? null
      : (outcome.text ??
        (error && isRawErrorPayload(error)
          ? TURN_FAILED_RAW_ERROR_MESSAGE
          : error) ??
        null);

    // OUTBOUND MENTIONS (plan: platform-rendered, loud failure). Scan the
    // model text the mirror posts (the answer and every follow-up reply) for
    // `@[Name]` tokens and ask the control plane to resolve them against
    // linked teammates BEFORE rendering; the renderer emits `<@U…>` for
    // resolved names and visible plain `@Name` for the rest: never a silent
    // drop, never a guess. One call for all of it. Fail OPEN: a resolve
    // outage posts with every token degraded (empty map) rather than
    // blocking, and the failure report is best-effort. The post always wins.
    // An automation's text (the report, and a joined wake's reply as its
    // caption body) is chrome-framed and never resolves.
    const repliesPosted = automated
      ? []
      : (item.followUps ?? []).flatMap((followUp) => {
          const reply = replyTo(followUp);
          return reply && !isAutomationSource(followUp.source) ? [reply] : [];
        });
    const { mentions, failures: mentionFailures } = await resolveMentionsIn(
      deps,
      automated ? [] : [answer, ...repliesPosted],
    );
    // A failed turn whose post is its PARTIAL answer text must not read as a
    // normal reply — the failure line rides after it. When the answer came
    // from `turn.error` or the error event, that text IS the failure message
    // and posts alone.
    const failedWithPartialText =
      item.turn.status === "failed" && outcome.text !== null;
    // A STOPPED turn whose post is its partial answer gets the closure word
    // after it, as on the web (the text, then "Stopped."). Without it a Stop
    // clicked after the agent had said anything left no sign in the thread
    // that it took. An abort that carries an error posts that error alone,
    // the web's precedence too.
    const stoppedAfterText =
      item.turn.status === "aborted" && outcome.text !== null && !error;

    // THE AGENT'S FILES (send_file): after the answer, as one share. Bytes
    // are pulled here (the work poll carries metadata only) and each pull
    // is independent — one unreadable file becomes a named "unavailable"
    // line, never a reason to drop its siblings. Declared here so BOTH the
    // automation report and the conversational answer post them: a cron's
    // report with its PDF is the whole point of the feature.
    const postOutboundFiles = async (): Promise<void> => {
      const outbound = item.turn.attachments ?? [];
      if (outbound.length === 0) return;
      const files: OutboundFile[] = [];
      const unavailable: UnavailableFile[] = [];
      const doorFor = (id: string): { url?: string } =>
        deps.attachmentUrl ? { url: deps.attachmentUrl(id) } : {};
      for (const meta of outbound) {
        const bytes =
          meta.sizeBytes <= MAX_MIRRORED_FILE_BYTES
            ? await deps.controlPlane
                .fetchAttachment(meta.id, MAX_MIRRORED_FILE_BYTES)
                .catch((err: unknown) => {
                  deps.onLog("outbound attachment fetch failed", {
                    err: String(err),
                    attachmentId: meta.id,
                  });
                  return null;
                })
            : null;
        if (bytes) {
          files.push({
            id: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            caption: meta.caption,
            bytes,
          });
        } else {
          unavailable.push({ name: meta.name, ...doorFor(meta.id) });
        }
      }
      await deps.posts.files({
        ...target,
        files,
        unavailable,
        ...(deps.attachmentUrl && { attachmentUrl: deps.attachmentUrl }),
      });
    };

    // Words the provider thread has not seen: the turn's own message when
    // it came from elsewhere, and the mid-run follow-ups the turn consumed,
    // each followed by the agent's own reply to it when it wrote one (the
    // answer covers the rest, so without these lines the thread shows an
    // answer to questions it never saw). Provider-sourced messages are
    // already in the channel: posting them again would echo the user.
    // (A peer agent's words never reach a person's thread since peer
    // tasks: the exchange stays on the pair conversations, and only the
    // agent's own report comes home, as an automation post.)
    const postSourced = async (line: {
      userName: string | null;
      message: string;
    }) => {
      await deps.posts.webSourced({
        ...target,
        userName: line.userName,
        message: line.message,
      });
    };
    const postFollowUps = async (
      replyMentions: ReadonlyMap<string, string> | undefined,
    ): Promise<void> => {
      for (const followUp of item.followUps ?? []) {
        // A follow-up whose reply the feed already posted mid-run is fully
        // in the channel (a web-sourced one's words went ahead of its
        // reply): nothing of it posts again. Otherwise claim first (the
        // same compare-and-set the feed uses), so a feed poll racing this
        // close can never post the reply twice. A follow-up with no reply
        // of its own has nothing to claim.
        if (followUp.replyPosted) continue;
        const reply = (await claimReplyOf(followUp))
          ? replyTo(followUp)
          : undefined;
        // A provider-sourced follow-up is already in the channel: only its
        // reply is missing there.
        if (followUp.source === deps.provider) {
          // Answered where that message was asked: the turn's own rule,
          // per message.
          if (reply) {
            await postModelText(
              deps,
              targetFor(followUp),
              reply,
              replyMentions,
            );
          }
          continue;
        }
        // A wake that joined this turn is the platform's instruction, not a
        // person's words: it posts as its automation caption (never as a web
        // quote), and what the agent said back to it, when it wrote
        // something, is the caption's body. Otherwise the answer is its
        // report.
        if (isAutomationSource(followUp.source)) {
          await deps.posts.automation({
            ...target,
            source: followUp.source,
            title: followUp.message,
            body: reply ?? null,
          });
          continue;
        }
        // Attributed by the follow-up's OWN author. An older control plane
        // sends no per-follow-up name (field absent), so fall back to the
        // turn's asker, the pre-field behavior, exact on direct threads.
        // Null means the control plane resolved and found nothing (deleted
        // user): unnamed.
        await postSourced({
          userName:
            followUp.userName === undefined
              ? (item.turn.userName ?? null)
              : followUp.userName,
          message: followUp.message,
        });
        // What the agent said back to it, right under it: the web's layout.
        if (reply) {
          await postModelText(deps, targetFor(followUp), reply, replyMentions);
        }
      }
    };

    if (item.turn.source === GREETING_SOURCE) {
      // The agent's first words on a brand-new thread. The instruction the
      // platform posted is not a person's question (no web attribution),
      // and it is not a run report either (no header): on Slack the person
      // simply sees their agent say hello. A greeting with no answer (the
      // instruction failed) posts nothing — there is no failure to report
      // to someone who has not asked anything yet.
      if (answer && outcome.text) {
        await deps.posts.answer({ ...target, markdown: answer, mentions });
      }
      return item.turn.createdAt;
    }

    if (automated) {
      // A wake that joined this one (a batch finishing seconds apart) and
      // what the agent said back to it, ahead of the report: the web's
      // layout. Automation text never resolves mentions (see below).
      await postFollowUps(undefined);
      await deps.posts.automation({
        ...target,
        source: automated,
        title: item.turn.message,
        body: answer,
      });
      await postOutboundFiles();
      return item.turn.createdAt;
    }

    if (!fromProvider) {
      await postSourced({
        // By name when the control plane resolved one.
        userName: item.turn.userName ?? null,
        message: item.turn.message,
      });
    }
    await postFollowUps(mentions);

    if (answer) {
      // A key-problem failure gets the web's same call to action. Only when
      // the CODE says so — never inferred from prose — and only with a URL
      // to point at; without one it falls through to the plain answer.
      if (item.turn.errorCode === "no_model_key" && deps.modelsUrl) {
        await deps.posts.noModelKey({
          ...target,
          modelsUrl: deps.modelsUrl,
          answer,
        });
      } else if (
        item.turn.errorCode === "trial_credit_exhausted" &&
        deps.modelsUrl
      ) {
        await deps.posts.trialCreditExhausted({
          ...target,
          modelsUrl: deps.modelsUrl,
          answer,
        });
      } else if (
        item.turn.errorCode === "model_provider_error" &&
        deps.modelsUrl
      ) {
        await deps.posts.providerError({
          ...target,
          modelsUrl: deps.modelsUrl,
          answer,
        });
      } else {
        await postModelText(deps, target, answer, mentions);
        if (failedWithPartialText) {
          await deps.posts.failureNotice({
            ...target,
            message: TURN_FAILED_PARTIAL_MESSAGE,
            warn: true,
          });
        } else if (stoppedAfterText) {
          await deps.posts.failureNotice({
            ...target,
            message: TURN_STOPPED_MESSAGE,
            warn: false,
          });
        }
      }
    } else if (item.turn.status === "failed") {
      // NEVER silent on a failure: the cursor has advanced and the "seen"
      // reaction is already stripped, so posting nothing reads as the agent
      // ignoring the person (six messages died exactly this way, live).
      await deps.posts.failureNotice({
        ...target,
        message: TURN_FAILED_SILENT_MESSAGE,
        warn: true,
      });
    } else if (item.turn.status === "aborted") {
      // The web's word for the same moment — closure, not alarm.
      await deps.posts.failureNotice({
        ...target,
        message: TURN_STOPPED_MESSAGE,
        warn: false,
      });
    }
    await postOutboundFiles();

    // LOUD FAILURE, second half: the answer posted with degraded mentions —
    // record which, so the next turn's context tells the model instead of
    // letting it believe the ping happened. After the posts (the answer
    // always wins over the report) and best-effort (the CAS already made
    // this adapter the only reporter; a lost report costs one note, never
    // the answer).
    if (mentionFailures.length > 0) {
      await deps.controlPlane
        .reportMentionFailures(item.turn.id, mentionFailures)
        .catch((err: unknown) =>
          deps.onLog("mention failure report failed", { err }),
        );
    }
  } catch (err) {
    // The cursor already moved: log loudly rather than retry into a double
    // post. The web remains the complete record.
    deps.onLog("mirror post failed after cursor advance", {
      err: String(err),
      turnId: item.turn.id,
    });
    // A refusal that means the app itself is gone (deleted on the provider's
    // side, an uninstall whose webhook never reached us) is relayed through
    // the ingest door as the PROVIDER's own removal event — the control
    // plane flips the presence exactly as it would for the real webhook, so
    // the dashboard card, the agent's doc and its tools stop claiming the
    // channel. Which failures count, and the event's shape, are the
    // provider's (removalEventFor); this file stays channel-neutral.
    const removal = deps.removalEventFor(err);
    if (removal !== null) {
      await deps.controlPlane
        .ingest({
          presenceId: item.presenceId,
          eventId: `dead-credential:${item.turn.id}`,
          event: removal,
        })
        .catch((reportErr: unknown) =>
          deps.onLog("dead credential report failed", {
            err: String(reportErr),
            presenceId: item.presenceId,
          }),
        );
    }
  }

  return item.turn.createdAt;
};

/**
 * What the early reply post needs: the completion pass's deps minus the
 * finished-turn item and its cursor, plus the reply item itself.
 */
export type ReplyMirrorDeps = Omit<MirrorDeps, "item" | "knownCursor"> & {
  item: AdapterReplyItem;
};

/**
 * THE EARLY REPLY POST: the agent's reply to a mid-run
 * message, posted the moment the agent has written it, while the turn still
 * runs. One post, never edited (the de-streaming decision stands); the
 * completion pass later posts the turn's own answer and skips this reply.
 *
 * Claim FIRST: the compare-and-set on the follow-up row is the exactly-once
 * gate, so the post happens only on the winning side (a twin, or the
 * completion pass of a turn that just closed, loses and posts nothing). The
 * same claim-then-post trade-off as the cursor: a crash between the two
 * loses one Slack post, which beats a duplicate in a human thread.
 *
 * A follow-up typed on another surface (the web) is not in the channel
 * yet: its attributed words post first, then the reply, the same exchange
 * the completion pass would have mirrored at the close. Rendered exactly as
 * the completion pass renders it (`postModelText`: mentions resolved,
 * connect links carded), where the follow-up was asked.
 */
export const mirrorFollowUpReply = async (
  deps: ReplyMirrorDeps,
): Promise<void> => {
  const { item } = deps;
  const claimed = await deps.controlPlane.claimReply(item.followUp.id);
  // A deliberate silence (`[no reply]`) is claimed like any reply, so the
  // feed stops serving it on every poll, and then posts nothing.
  if (!claimed || isNoReply(item.reply)) return;

  const address = replyTargetForTurn(deps.threadAddress, item, item.followUp);
  const target: ChannelPostTarget = {
    credential: deps.credential,
    channel: address.channel,
    ...(address.threadTs && { threadTs: address.threadTs }),
    ...(deps.iconUrl && { iconUrl: deps.iconUrl }),
  };
  try {
    if (item.followUp.source !== deps.provider) {
      await deps.posts.webSourced({
        ...target,
        userName: item.followUp.userName,
        message: item.followUp.message,
      });
    }
    const { mentions, failures } = await resolveMentionsIn(deps, [item.reply]);
    await postModelText(deps, target, item.reply, mentions);
    if (failures.length > 0) {
      await deps.controlPlane
        .reportMentionFailures(item.turnId, failures)
        .catch((err: unknown) =>
          deps.onLog("mention failure report failed", { err }),
        );
    }
  } catch (err) {
    // Claimed, so never retried into a double post: the web remains the
    // complete record. A dead-credential refusal is relayed exactly as the
    // completion pass relays it.
    deps.onLog("reply post failed after claim", {
      err: String(err),
      followUpId: item.followUp.id,
    });
    const removal = deps.removalEventFor(err);
    if (removal !== null) {
      await deps.controlPlane
        .ingest({
          presenceId: item.presenceId,
          eventId: `dead-credential:${item.followUp.id}`,
          event: removal,
        })
        .catch((reportErr: unknown) =>
          deps.onLog("dead credential report failed", {
            err: String(reportErr),
            presenceId: item.presenceId,
          }),
        );
    }
  }
};
