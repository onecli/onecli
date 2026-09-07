import type { AdapterWorkItem } from "@onecli/agent-protocol";
// The client-safe app catalog (pure data, no Node builtins at import) — the
// card gate below must agree with the web's isCardConnectLink.
import { getApp } from "@onecli/api/apps/registry";
// The one definition of "automated turn" — shared with the control plane's
// continuity bridge, so a new automation source lands in both in one edit.
import {
  AUTOMATION_SOURCES,
  TURN_FAILED_PARTIAL_MESSAGE,
  TURN_FAILED_SILENT_MESSAGE,
  TURN_STOPPED_MESSAGE,
} from "@onecli/api/validations/conversation";
import type { ControlPlaneClient } from "./control-plane";
import { replyTargetForTurn, type ChannelPostTarget } from "./targets";

/**
 * The gateway's "connect this app" dashboard links, recognized in an answer
 * so the channel can render them as a card with a button — the web chat's
 * ConnectorSuggestions, translated to the channel's native blocks. Two
 * shapes (the same two `parseConnectLink` reads on the web):
 * - `…/connections?connect=<provider>…` — nothing connected yet
 * - `…/connections/apps/<provider>` — connected, not attached to this agent
 */
// The prefix is LAZY: greedy would swallow across two adjacent URLs (the
// `](` between a markdown label's link and its target is in the allowed
// class) and merge them into one match, losing the first provider's card.
// Each arm consumes a trailing query/fragment so span surgery lifts the
// WHOLE url — otherwise `…/apps/gmail?src=x` would card gmail and leave a
// dangling `?src=x` in the prose.
const CONNECT_LINK_RE =
  /https?:\/\/[^\s<>|]+?\/connections(?:\?(?:[^\s<>|]*&)?connect=([a-z0-9-]{1,64})(?![\w-])(?:&[^\s<>|]*)?(?:#[^\s<>|]*)?|\/apps\/([a-z0-9-]{1,64})(?![\w/-])(?:[?#][^\s<>|]*)?)/g;

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

/** Every connect-link occurrence in the answer, in order, with spans. */
const findConnectLinkMatches = (answer: string): ConnectLinkMatch[] => {
  const matches: ConnectLinkMatch[] = [];
  for (const match of answer.matchAll(CONNECT_LINK_RE)) {
    const provider = match[1] ?? match[2];
    if (!provider) continue;
    // Shed trailing punctuation the model may have glued on.
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
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
      kind: match[1] ? "connect" : "attach",
      start,
      end,
    });
  }
  return matches;
};

/** The card rows: one per provider (first occurrence wins), capped. */
const cardLinks = (matches: ConnectLinkMatch[]): ConnectLink[] => {
  const seen = new Set<string>();
  const links: ConnectLink[] = [];
  for (const { url, provider, kind } of matches) {
    if (seen.has(provider)) continue;
    // The web's isCardConnectLink law: only catalog apps get carded. A card
    // for a model-invented provider would strip the user's only real link
    // from the prose and assert a connection state as official UI (spoofed
    // favicon included) — an unknown id keeps its raw link instead.
    if (!getApp(provider)) continue;
    if (links.length >= MAX_CONNECT_CARDS) break;
    seen.add(provider);
    links.push({ url, provider, kind });
  }
  return links;
};

/** The answer with every occurrence of a carded provider's link removed by
 * exact span; links past the card cap stay put. */
const proseWithoutCardedLinks = (
  answer: string,
  matches: ConnectLinkMatch[],
  carded: ReadonlySet<string>,
): string => {
  let prose = "";
  let cursor = 0;
  for (const match of matches) {
    if (!carded.has(match.provider)) continue;
    // A wrapper-rewound span (a connect link nested inside another link's
    // markdown label) can start BEFORE the previous match's end; the
    // backwards slice is empty, so nothing duplicates — at worst a label
    // fragment of the model's own nesting stays behind.
    prose += answer.slice(cursor, match.start);
    cursor = Math.max(cursor, match.end);
  }
  return (prose + answer.slice(cursor)).trim();
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

const transcriptOutcome = async (
  controlPlane: ControlPlaneClient,
  conversationId: string,
  turnId: string,
): Promise<{ text: string | null; error: string | null }> => {
  let since: number | undefined;
  let text: string | null = null;
  // The turn's durable `error` event — the harness's terminal message, which
  // for uncoded failures is the ONLY record (the supervisor deliberately
  // sends no `turn.result.error` then, so `turn.error` is NULL). Last one
  // wins, matching the `text` semantics and the web's transcript fold.
  let error: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const history = await controlPlane.readTranscript(conversationId, since);
    for (const event of history.events) {
      if (event.turnId !== turnId) continue;
      const payload = (event.payload ?? {}) as {
        text?: string;
        message?: string;
      };
      if (event.type === "text" && payload.text) text = payload.text;
      if (event.type === "error" && payload.message) error = payload.message;
    }
    since = history.nextSince;
    if (!history.hasMore) break;
  }
  return { text, error };
};

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
  /** An automated run's report: the run's title as a caption, plus the body
   * (model markdown) when one exists. */
  automation(
    input: ChannelPostTarget & {
      source: "watch" | "cron";
      title: string;
      body: string | null;
    },
  ): Promise<void>;
  /** The turn's answer — model-authored markdown (or a door failure's plain
   * `turn.error`). */
  answer(input: ChannelPostTarget & { markdown: string }): Promise<void>;
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
  onLog: (message: string, detail?: unknown) => void;
}

/**
 * Handle one finished turn: post what the provider surface is missing, then
 * CAS the cursor. Returns the new cursor when this adapter won, or null when
 * a twin did (nothing was posted in that case).
 */
export const mirrorFinishedTurn = async (
  deps: MirrorDeps,
): Promise<string | null> => {
  const { item } = deps;
  // The turn's own address when it has one (a DM thread), else the link's —
  // so an answer lands in the thread its question was asked in.
  const link = replyTargetForTurn(item, item.turn);
  const target: ChannelPostTarget = {
    credential: deps.credential,
    channel: link.channel,
    ...(link.threadTs && { threadTs: link.threadTs }),
    ...(deps.iconUrl && { iconUrl: deps.iconUrl }),
  };

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
  // not a person's question — labelling it "(from the web)" would attribute
  // automation to a human. One message: the report, or the header when the
  // run produced none. The icon distinguishes the two, and watch volume is
  // bounded by one-shot semantics (the decided answer to the posting-shape
  // question). `AUTOMATION_SOURCES` is the control plane's own definition
  // (its continuity bridge branches on the same constant), so a new
  // automation source lands in both places in one edit.
  const automated = (AUTOMATION_SOURCES as readonly string[]).includes(
    item.turn.source,
  );

  try {
    const outcome = await transcriptOutcome(
      deps.controlPlane,
      item.conversationId,
      item.turn.id,
    );
    // Precedence mirrors the web (turn-block prefers `turn.error`): the
    // agent's own text first; then the canonical/raw `turn.error`; then the
    // transcript's durable error event — the only record an UNCODED harness
    // failure leaves, which used to fall through to total silence here.
    const answer = outcome.text ?? item.turn.error ?? outcome.error ?? null;
    // A failed turn whose post is its PARTIAL answer text must not read as a
    // normal reply — the failure line rides after it. When the answer came
    // from `turn.error` or the error event, that text IS the failure message
    // and posts alone.
    const failedWithPartialText =
      item.turn.status === "failed" && outcome.text !== null;

    if (automated) {
      await deps.posts.automation({
        ...target,
        source: item.turn.source === "watch" ? "watch" : "cron",
        title: item.turn.message,
        body: answer,
      });
      return item.turn.createdAt;
    }

    if (!fromProvider) {
      // The question came from elsewhere (the web): show it, attributed —
      // by name when the control plane resolved one.
      await deps.posts.webSourced({
        ...target,
        userName: item.turn.userName ?? null,
        message: item.turn.message,
      });
    }

    // Mid-run follow-ups the turn consumed: the answer below covers them, so
    // the provider thread must show the web-sourced ones or it reads as an
    // answer to questions it never saw. Provider-sourced follow-ups are
    // already in the channel — posting them again would echo the user.
    for (const followUp of item.followUps ?? []) {
      if (followUp.source === deps.provider) continue;
      // Attributed by the follow-up's OWN author. An older control plane
      // sends no per-follow-up name (field absent) — fall back to the turn's
      // asker, the pre-field behavior, exact on direct threads. Null means
      // the control plane resolved and found nothing (deleted user): unnamed.
      await deps.posts.webSourced({
        ...target,
        userName:
          followUp.userName === undefined
            ? (item.turn.userName ?? null)
            : followUp.userName,
        message: followUp.message,
      });
    }

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
        // Connect links render as a card with a button (the web chat's
        // treatment): the raw URL leaves the prose, and each app gets a
        // context row + button. Card buttons are built only from the
        // configured chat URL — a button hides its domain, so it must never
        // carry a model-authored URL. No chat URL (or no links) → the plain
        // answer as before, raw link visible in the prose.
        // The 40k ceiling matches mrkdwn's hostile-input fence and keeps the
        // link scan's worst case bounded — an answer past it posts plain.
        const chatUrl = deps.chatUrl;
        const matches =
          chatUrl && answer.length <= 40_000
            ? findConnectLinkMatches(answer)
            : [];
        const connectLinks = cardLinks(matches);
        if (chatUrl && connectLinks.length > 0) {
          const carded = new Set(connectLinks.map((link) => link.provider));
          // The adapter mints chatUrl query-free today, but the invariant
          // lives here, not at the construction site — join accordingly.
          const sep = chatUrl.includes("?") ? "&" : "?";
          await deps.posts.connectCards({
            ...target,
            markdown: proseWithoutCardedLinks(answer, matches, carded),
            fullMarkdown: answer,
            links: connectLinks.map((link) => ({
              ...link,
              // Deep-link into the chat's attach dialog over the conversation.
              url: `${chatUrl}${sep}attach=${encodeURIComponent(link.provider)}`,
            })),
          });
        } else {
          await deps.posts.answer({ ...target, markdown: answer });
        }
        if (failedWithPartialText) {
          await deps.posts.failureNotice({
            ...target,
            message: TURN_FAILED_PARTIAL_MESSAGE,
            warn: true,
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
  } catch (err) {
    // The cursor already moved: log loudly rather than retry into a double
    // post. The web remains the complete record.
    deps.onLog("mirror post failed after cursor advance", {
      err: String(err),
      turnId: item.turn.id,
    });
  }

  return item.turn.createdAt;
};
