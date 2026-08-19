import type { AdapterWorkItem } from "@onecli/agent-protocol";
import type { ControlPlaneClient } from "./control-plane";
import { replyTargetForLink, type ChannelPostTarget } from "./targets";

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

const answerFromTranscript = async (
  controlPlane: ControlPlaneClient,
  conversationId: string,
  turnId: string,
): Promise<string | null> => {
  let since: number | undefined;
  let answer: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const history = await controlPlane.readTranscript(conversationId, since);
    for (const event of history.events) {
      if (event.turnId !== turnId) continue;
      const payload = (event.payload ?? {}) as { text?: string };
      if (event.type === "text" && payload.text) answer = payload.text;
    }
    since = history.nextSince;
    if (!history.hasMore) break;
  }
  return answer;
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
  const link = replyTargetForLink(item);
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
  // question). This list mirrors `AUTOMATION_SOURCES` in @onecli/api's
  // conversation validations. This app cannot import that package, so the
  // two are kept in sync by convention — a new automation source must be
  // added in BOTH places or it will be bridged in the control plane yet
  // mis-attributed here.
  const automated = item.turn.source === "cron" || item.turn.source === "watch";

  try {
    const answer =
      (await answerFromTranscript(
        deps.controlPlane,
        item.conversationId,
        item.turn.id,
      )) ??
      item.turn.error ??
      null;

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
        item.turn.errorCode === "model_provider_error" &&
        deps.modelsUrl
      ) {
        await deps.posts.providerError({
          ...target,
          modelsUrl: deps.modelsUrl,
          answer,
        });
      } else {
        await deps.posts.answer({ ...target, markdown: answer });
      }
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
