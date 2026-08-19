import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterWorkItem, AdapterWorkTurn } from "@onecli/agent-protocol";
import type { ControlPlaneClient } from "./control-plane";
import { mirrorFinishedTurn } from "./mirror";
import { slackMirrorPosts } from "./slack/mirror-posts";
import {
  createFakeControlPlane,
  startFakeSlackServer,
  type FakeSlackServer,
} from "./test/fakes";

/**
 * The mirror/catch-up pass. Its whole safety story is ONE ordering: the
 * cursor CAS is taken BEFORE anything is posted, so of two adapters (deploy
 * overlap, restart twin) exactly one posts and the other posts nothing.
 * The price — a crash between claim and post drops that mirror — is the
 * documented at-most-once tradeoff: a duplicate post into a human channel
 * is worse than a missing copy of something the web already shows.
 */

let slack: FakeSlackServer;

beforeEach(async () => {
  slack = await startFakeSlackServer();
  process.env.SLACK_API_BASE_URL = slack.url;
});

afterEach(async () => {
  delete process.env.SLACK_API_BASE_URL;
  await slack.close();
});

const turn = (overrides: Partial<AdapterWorkTurn> = {}): AdapterWorkTurn => ({
  id: "t1",
  status: "completed",
  source: "web",
  userId: "u1",
  message: "Deploy it <now>",
  error: null,
  errorCode: null,
  createdAt: "2026-08-06T10:00:00.000Z",
  finishedAt: "2026-08-06T10:00:20.000Z",
  ...overrides,
});

const item = (
  turnOverrides: Partial<AdapterWorkTurn> = {},
): AdapterWorkItem => ({
  linkId: "l1",
  presenceId: "p1",
  conversationId: "cv1",
  externalThreadId: "D100",
  kind: "direct",
  turn: turn(turnOverrides),
});

/** A transcript whose only text event answers t1. */
const transcriptWith = (
  answer: string | null,
): Pick<ControlPlaneClient, "readTranscript"> => ({
  readTranscript: async () => ({
    events: answer
      ? [{ seq: 1, turnId: "t1", type: "text", payload: { text: answer } }]
      : [],
    nextSince: 2,
    hasMore: false,
  }),
});

const mirror = (input: {
  controlPlane: ControlPlaneClient;
  workItem?: AdapterWorkItem;
  knownCursor?: string | null;
  iconUrl?: string | null;
  modelsUrl?: string;
  onLog?: (message: string, detail?: unknown) => void;
}) =>
  // The REAL Slack posts implementation rides the fake HTTP server — the
  // mirror itself is channel-general and only sees the seam.
  mirrorFinishedTurn({
    controlPlane: input.controlPlane,
    credential: "xoxb-bot",
    provider: "slack",
    posts: slackMirrorPosts,
    iconUrl: input.iconUrl ?? null,
    knownCursor: input.knownCursor ?? "2026-08-05T00:00:00.000Z",
    item: input.workItem ?? item(),
    ...(input.modelsUrl && { modelsUrl: input.modelsUrl }),
    onLog: input.onLog ?? (() => {}),
  });

describe("the claim-then-post law", () => {
  it("advances the cursor BEFORE any Slack post, with the known expectation", async () => {
    // MUTATION-PROOF: swap the CAS below the posts and a twin adapter (or a
    // crash-retry) posts the same answer twice into a human channel — the
    // exact failure the CAS exists to make impossible.
    const order: string[] = [];
    const casArgs: [string, string | null, string][] = [];
    slack.onCall = (call) => order.push(`slack:${call.method}`);
    const controlPlane = createFakeControlPlane({
      ...transcriptWith("It is done."),
      advanceCursor: async (linkId, expect_, next) => {
        order.push("cas");
        casArgs.push([linkId, expect_, next]);
        return true;
      },
    });

    const next = await mirror({ controlPlane });

    expect(next).toBe("2026-08-06T10:00:00.000Z");
    expect(order[0]).toBe("cas");
    expect(order.slice(1)).toEqual([
      "slack:chat.postMessage",
      "slack:chat.postMessage",
    ]);
    expect(casArgs).toEqual([
      ["l1", "2026-08-05T00:00:00.000Z", "2026-08-06T10:00:00.000Z"],
    ]);
  });

  it("posts NOTHING and returns null when the CAS is lost", async () => {
    // The twin won: this adapter's copy of the world is stale, and even
    // reading the transcript would be wasted work.
    let transcriptReads = 0;
    const controlPlane = createFakeControlPlane({
      advanceCursor: async () => false,
      readTranscript: async () => {
        transcriptReads += 1;
        return { events: [], nextSince: 0, hasMore: false };
      },
    });

    const next = await mirror({ controlPlane });

    expect(next).toBeNull();
    expect(slack.calls).toEqual([]);
    expect(transcriptReads).toBe(0);
  });
});

describe("what gets posted", () => {
  it("mirrors a web-sourced turn as attributed question + answer, both escaped", async () => {
    const controlPlane = createFakeControlPlane(
      transcriptWith("It is done <ok>"),
    );

    await mirror({ controlPlane });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted.map((call) => call.form.text)).toEqual([
      "_(from the web)_ Deploy it &lt;now&gt;",
      "It is done &lt;ok&gt;",
    ]);
    expect(posted.every((call) => call.form.channel === "D100")).toBe(true);
    // No avatar in the deps — no icon_url key on either post.
    expect(posted.every((call) => !("icon_url" in call.form))).toBe(true);
  });

  it("carries the agent's avatar as icon_url on every mirrored post when set", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith("It is done."));

    await mirror({
      controlPlane,
      iconUrl: "https://api.example.com/v1/agent-images/ag1/abc",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(2);
    expect(
      posted.every(
        (call) =>
          call.form.icon_url ===
          "https://api.example.com/v1/agent-images/ag1/abc",
      ),
    ).toBe(true);
  });

  it("mirrors the human's words VERBATIM — the continuity bridge never rides turn.message to Slack", async () => {
    // The Slack leak the user hit (2026-08-07): the step-7 continuity bridge
    // used to be prepended INTO turn.message, so this attributed mirror echoed
    // the whole "[Context from your automated runs …]" block as if the person
    // had typed it. The mirror faithfully posts turn.message, so the fix is
    // upstream — the bridge now rides the delivery-only context channel and
    // turn.message stays the human's words. This locks that contract at the
    // Slack boundary: a leaked prefix would land here, so it must not exist.
    const humanWords = "can you wait 10 seconds, and then tell me the time?";
    const controlPlane = createFakeControlPlane(transcriptWith("It is 12:00."));

    await mirror({
      controlPlane,
      workItem: item({ source: "web", message: humanWords }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted[0]?.form.text).toBe(`_(from the web)_ ${humanWords}`);
    expect(posted[0]?.form.text).not.toContain(
      "[Context from your automated runs",
    );
  });

  it("posts a scheduled run's report as ONE labeled message — never '(from the web)'", async () => {
    // A cron delivery is platform-materialized: its message is the schedule
    // header, not a person's question, and attributing automation to a human
    // is the mislabel this arm exists to prevent. MUTATION-PROOF: drop the
    // `scheduled` branch from mirrorFinishedTurn and this fails.
    const controlPlane = createFakeControlPlane(
      transcriptWith("Inbox is clear <ok>"),
    );

    await mirror({
      controlPlane,
      workItem: item({
        source: "cron",
        userId: null,
        message: 'Scheduled run "daily-check"',
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    // The title rides every automation post as a quiet caption — two
    // automations reporting into one thread are indistinguishable without it.
    expect(posted.map((call) => call.form.text)).toEqual([
      ':calendar: _Scheduled run "daily-check"_\nInbox is clear &lt;ok&gt;',
    ]);
  });

  it("posts a watch run's report as ONE labeled message with the stopwatch icon", async () => {
    // A watch delivery shares the cron shape but a distinct icon, keyed on the
    // source. MUTATION-PROOF: flip the :stopwatch:/:calendar: ternary (or drop
    // "watch" from the automation check) and this fails.
    const controlPlane = createFakeControlPlane(
      transcriptWith("Tests passed <ok>"),
    );

    await mirror({
      controlPlane,
      workItem: item({
        source: "watch",
        userId: null,
        message: 'Watch on "tests"',
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted.map((call) => call.form.text)).toEqual([
      ':stopwatch: _Watch on "tests"_\nTests passed &lt;ok&gt;',
    ]);
  });

  it("posts only the answer for a provider-sourced turn", async () => {
    // The question already sits in the Slack thread — the human typed it
    // there; re-posting it would echo everyone back at themselves.
    const controlPlane = createFakeControlPlane(transcriptWith("The answer."));

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
    });

    expect(slack.callsTo("chat.postMessage").map((c) => c.form.text)).toEqual([
      "The answer.",
    ]);
  });

  it("renders the answer's markdown as mrkdwn — bold, bullets, links", async () => {
    // MUTATION-PROOF: revert the answer post to escapeSlackText(answer) and
    // this fails — the whole point of the converter is that **bold** stops
    // showing literal asterisks in Slack.
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "## Result\n- **state:** green\n[docs](https://e.com/a_(b)) <ok>",
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
    });

    expect(slack.callsTo("chat.postMessage").map((c) => c.form.text)).toEqual([
      "*Result*\n• *state:* green\n<https://e.com/a_(b)|docs> &lt;ok&gt;",
    ]);
  });

  it("converts the automated report body under the verbatim title caption", async () => {
    // The report is model markdown — converted. The TITLE stays a quoted
    // caption above it (escape only, never converted): reports do not
    // self-identify, so the caption is what tells two automations apart.
    const controlPlane = createFakeControlPlane(
      transcriptWith("## Inbox\n- **unread:** 0"),
    );

    await mirror({
      controlPlane,
      workItem: item({
        source: "cron",
        userId: null,
        message: "Scheduled run **daily** <sweep>",
      }),
    });

    expect(slack.callsTo("chat.postMessage").map((c) => c.form.text)).toEqual([
      ":calendar: _Scheduled run **daily** &lt;sweep&gt;_\n*Inbox*\n• *unread:* 0",
    ]);
  });

  it("falls back to the escaped title when the automated run produced no body", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      workItem: item({
        source: "cron",
        userId: null,
        message: "Scheduled run **daily** <sweep>",
      }),
    });

    expect(slack.callsTo("chat.postMessage").map((c) => c.form.text)).toEqual([
      ":calendar: _Scheduled run **daily** &lt;sweep&gt;_",
    ]);
  });

  it("quotes web-sourced questions VERBATIM — markdown in a human's words is not converted", async () => {
    // The attributed mirror is a quote, not a rendering: a person who typed
    // literal asterisks said literal asterisks.
    const controlPlane = createFakeControlPlane(transcriptWith("Done."));

    await mirror({
      controlPlane,
      workItem: item({ source: "web", message: "is **this** bold?" }),
    });

    expect(slack.callsTo("chat.postMessage")[0]?.form.text).toBe(
      "_(from the web)_ is **this** bold?",
    );
  });

  it("attributes a web-sourced turn by NAME when the control plane resolved one — italic, escaped", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith("Done."));

    await mirror({
      controlPlane,
      workItem: item({ userName: "Jonathan <j>" }),
    });

    // Italic: the attribution is metadata and must stay quieter than the
    // quoted words themselves.
    expect(slack.callsTo("chat.postMessage")[0]?.form.text).toBe(
      "_(from the web · Jonathan &lt;j&gt;)_ Deploy it &lt;now&gt;",
    );
  });

  it("attributes each follow-up by ITS OWN author — named, null → unnamed, absent → the asker (legacy)", async () => {
    // On a group thread the follow-up author can differ from the turn's
    // asker. Named rows use their own name; an explicit null (the control
    // plane resolved and found nothing — deleted user) renders unnamed; an
    // ABSENT field (an older control plane that predates per-follow-up
    // names) falls back to the asker's name, the pre-field behavior.
    // MUTATION-PROOF: reuse the turn's name for every follow-up and Bob's
    // line below surfaces under Alice's name.
    const controlPlane = createFakeControlPlane(transcriptWith("Covers all."));

    await mirror({
      controlPlane,
      workItem: {
        ...item({ source: "slack", userName: "Alice" }),
        followUps: [
          { message: "from Bob", source: "web", userName: "Bob" },
          { message: "from a deleted user", source: "web", userName: null },
          { message: "old control plane", source: "web" },
        ],
      },
    });

    expect(slack.callsTo("chat.postMessage").map((c) => c.form.text)).toEqual([
      "_(from the web · Bob)_ from Bob",
      "_(from the web)_ from a deleted user",
      "_(from the web · Alice)_ old control plane",
      "Covers all.",
    ]);
  });

  it("posts the turn's WEB-sourced joined follow-ups before the answer — Slack-sourced ones never echo", async () => {
    // Mid-run follow-ups the turn consumed: without the web-sourced lines
    // the Slack thread shows an answer to questions it never saw; WITH the
    // Slack-sourced ones it would echo the user's own message back. Both
    // directions are load-bearing.
    const controlPlane = createFakeControlPlane(
      transcriptWith("Covers both <asks>"),
    );

    await mirror({
      controlPlane,
      workItem: {
        ...item({ source: "slack" }),
        followUps: [
          { message: "web follow-up <one>", source: "web" },
          { message: "slack follow-up", source: "slack" },
        ],
      },
    });

    expect(slack.callsTo("chat.postMessage").map((c) => c.form.text)).toEqual([
      "_(from the web)_ web follow-up &lt;one&gt;",
      "Covers both &lt;asks&gt;",
    ]);
  });

  it("threads both posts when the link is a group thread", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith("Done."));

    await mirror({
      controlPlane,
      workItem: { ...item(), kind: "group", externalThreadId: "C7:99.5" },
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(2);
    expect(posted.every((call) => call.form.channel === "C7")).toBe(true);
    expect(posted.every((call) => call.form.thread_ts === "99.5")).toBe(true);
  });

  it("falls back to the turn's error when the transcript has no text event", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      workItem: item({
        source: "slack",
        error: "The model provider refused <retry>",
        errorCode: "provider_refused",
      }),
    });

    expect(slack.callsTo("chat.postMessage").map((c) => c.form.text)).toEqual([
      "The model provider refused &lt;retry&gt;",
    ]);
  });

  it("posts the no-model-key card — headline, context line, and a button to the Models page", async () => {
    // The web's same call to action, structured: keyed on the CODE (never
    // prose) and gated on having a URL to point at. The canonical sentence
    // stays as the notification fallback text.
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      modelsUrl: "https://app.example.com/w/ws1/agents/ag1/models",
      workItem: item({
        source: "slack",
        error: "No key <yet>.",
        errorCode: "no_model_key",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("No key &lt;yet&gt;.");
    const blocks = JSON.parse(posted[0]!.form.blocks!) as {
      type: string;
      text?: { text: string };
      elements?: {
        type: string;
        text?: { text: string };
        url?: string;
        action_id?: string;
      }[];
    }[];
    expect(blocks[0]?.text?.text).toBe("*This agent has no model key yet*");
    const button = blocks.find((b) => b.type === "actions")?.elements?.[0];
    expect(button?.url).toBe("https://app.example.com/w/ws1/agents/ag1/models");
    expect(button?.action_id).toBe("open_models_page");
    expect(button?.text?.text).toBe("Connect a model key");
  });

  it("falls back to the plain answer when no models URL is configured — the failure still posts", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      workItem: item({
        source: "slack",
        error: "No key <yet>.",
        errorCode: "no_model_key",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("No key &lt;yet&gt;.");
    expect("blocks" in posted[0]!.form).toBe(false);
  });

  it("posts the provider-error card — headline, context line, and a button to the Models page", async () => {
    // The supervisor now produces `model_provider_error` and finishTurn's
    // allowlist carries it, so the code earns the web's same call to action
    // here too: keyed on the CODE (never prose), gated on having a URL. The
    // canonical sentence stays as the notification fallback text.
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      modelsUrl: "https://app.example.com/w/ws1/agents/ag1/models",
      workItem: item({
        source: "slack",
        error: "The provider rejected <this>.",
        errorCode: "model_provider_error",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("The provider rejected &lt;this&gt;.");
    const blocks = JSON.parse(posted[0]!.form.blocks!) as {
      type: string;
      text?: { text: string };
      elements?: {
        type: string;
        text?: { text: string };
        url?: string;
        action_id?: string;
      }[];
    }[];
    expect(blocks[0]?.text?.text).toBe(
      "*The model provider rejected the request*",
    );
    const button = blocks.find((b) => b.type === "actions")?.elements?.[0];
    expect(button?.url).toBe("https://app.example.com/w/ws1/agents/ag1/models");
    expect(button?.action_id).toBe("open_models_page");
    expect(button?.text?.text).toBe("Check the model key");
  });

  it("provider-error degrades to the plain answer when no models URL is configured", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      workItem: item({
        source: "slack",
        error: "The provider rejected <this>.",
        errorCode: "model_provider_error",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("The provider rejected &lt;this&gt;.");
    expect("blocks" in posted[0]!.form).toBe(false);
  });

  it("treats an UNKNOWN error code as a plain answer — no card is invented without a producer", async () => {
    // Cards exist only for codes with a wired arm; anything else takes the
    // plain-answer path even with a models URL configured.
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      modelsUrl: "https://app.example.com/w/ws1/agents/ag1/models",
      workItem: item({
        source: "slack",
        error: "Provider said no <retry>",
        errorCode: "mystery_code",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("Provider said no &lt;retry&gt;");
    expect("blocks" in posted[0]!.form).toBe(false);
  });

  it("posts nothing at all when there is neither answer nor error, but still advances", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    const next = await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
    });

    expect(slack.calls).toEqual([]);
    expect(next).toBe("2026-08-06T10:00:00.000Z");
  });
});

describe("post failure after the cursor advanced", () => {
  it("logs loudly and still returns the new cursor — no retry into a double post", async () => {
    // The documented tradeoff: once the CAS moved, a retry could no longer
    // tell "my post failed" from "my twin already posted", so the mirror is
    // dropped and the web remains the complete record.
    const logs: string[] = [];
    slack.respond("chat.postMessage", () => ({
      ok: false,
      error: "channel_not_found",
    }));
    const controlPlane = createFakeControlPlane(transcriptWith("Answer."));

    const next = await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      onLog: (message) => logs.push(message),
    });

    expect(next).toBe("2026-08-06T10:00:00.000Z");
    expect(logs).toContain("mirror post failed after cursor advance");
    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
  });
});
