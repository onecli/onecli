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
  status: "done",
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
  chatUrl?: string;
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
    ...(input.chatUrl && { chatUrl: input.chatUrl }),
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
    // The caption rides every automation post — two automations reporting
    // into one thread are indistinguishable without it. `text` carries the
    // whole line because it is the notification and search preview.
    expect(posted.map((call) => call.form.text)).toEqual([
      ':calendar: Scheduled run "daily-check"\nInbox is clear &lt;ok&gt;',
    ]);
    // ...and the caption renders as CHROME: a context block (smaller, grey),
    // with the report itself an ordinary section below it.
    const blocks = JSON.parse(posted[0]?.form.blocks ?? "[]") as unknown[];
    expect(blocks[0]).toEqual({
      type: "context",
      elements: [
        { type: "mrkdwn", text: ':calendar: Scheduled run "daily-check"' },
      ],
    });
    expect(blocks[1]).toMatchObject({ type: "section" });
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
      ':stopwatch: Watch on "tests"\nTests passed &lt;ok&gt;',
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

  it("renders a gateway connect link as a card with a button, not a bare URL", async () => {
    // The web chat renders these links as the ConnectorSuggestions card; the
    // Slack mirror does the Block Kit equivalent — the raw URL leaves the
    // prose, and the app row carries an Attach/Connect link button.
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "You'll need to attach the account to me here: https://app.example.com/w/ws1/connections/apps/google-calendar\nLet me know once it's attached.",
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    const blocks = JSON.parse(posted[0]!.form.blocks!) as {
      type: string;
      text?: { text: string };
      elements?: {
        type: string;
        text?: { text: string } | string;
        url?: string;
        image_url?: string;
      }[];
    }[];
    const rendered = JSON.stringify(blocks);
    // The raw URL is not in the prose section…
    expect(blocks[0]?.text?.text).not.toContain("connections/apps");
    // …the card names the app, its state, and its icon…
    expect(rendered).toContain("Google Calendar");
    expect(rendered).toContain("Attach an account to this agent");
    expect(rendered).toContain("faviconV2");
    expect(rendered).toContain("calendar.google.com");
    // …and the button deep-links to the agent's chat with the attach param
    // (the web opens the attach dialog over the conversation).
    const button = blocks
      .filter((b) => b.type === "actions")
      .flatMap((b) => b.elements ?? [])
      .find((el) => el.type === "button");
    expect((button?.text as { text: string } | undefined)?.text).toBe("Attach");
    expect(button?.url).toBe(
      "https://app.example.com/w/ws1/agents/ag1/chat?attach=google-calendar",
    );
  });

  it("posts the plain answer when no chat URL is configured — a card button never carries a model-authored URL", async () => {
    // MUTATION-PROOF: render the card on the degraded path anyway (button
    // url = the matched link) and this fails — the answer is model prose, so
    // that button would put whatever domain the model wrote behind a
    // domain-hiding button. As a bare link in the prose the domain stays
    // visible.
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "Attach it here: https://evil.example.com/connections/apps/google-calendar",
      ),
    );

    await mirror({ controlPlane, workItem: item({ source: "slack" }) });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.form.blocks).toBeUndefined();
    expect(posted[0]!.form.text).toContain("evil.example.com");
  });

  it("caps the card rows so a link-stuffed answer cannot exceed Slack's block limit", async () => {
    // Slack rejects a message over 50 blocks and each card row costs two —
    // an answer stuffed with links must still post: capped rows, the rest
    // left in the prose. MUTATION-PROOF: drop the cap in cardLinks and the
    // actions count below reads 12. Real catalog ids: the card gate rejects
    // invented providers, which is its own test below.
    const providers = [
      "gmail",
      "github",
      "gitlab",
      "docker",
      "dropbox",
      "confluence",
      "datadog",
      "cloudflare",
      "aws",
      "flyio",
      "attio",
      "affinity",
    ];
    const links = providers.map(
      (id) => `https://app.example.com/w/ws1/connections?connect=${id}`,
    );
    const controlPlane = createFakeControlPlane(
      transcriptWith(`Connect these: ${links.join(" ")}`),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    const blocks = JSON.parse(posted[0]!.form.blocks!) as { type: string }[];
    expect(blocks.filter((b) => b.type === "actions")).toHaveLength(10);
    // The links past the cap stay in the prose rather than vanishing.
    const prose = JSON.stringify(blocks[0]);
    expect(prose).toContain("connect=attio");
    expect(prose).toContain("connect=affinity");
  });

  it("never cards a provider the app catalog does not know", async () => {
    // MUTATION-PROOF: drop the getApp gate in cardLinks and this fails —
    // a model-invented provider would otherwise strip the user's only real
    // link from the prose and assert an official-looking attach row
    // UI, favicon and all (the web's isCardConnectLink law).
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "Attach it here: https://app.example.com/w/ws1/connections/apps/paypal-fake",
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.form.blocks).toBeUndefined();
    expect(posted[0]!.form.text).toContain("connections/apps/paypal-fake");
  });

  it("only recognizes the exact connect shapes — ?reconnect= and deeper /apps/ paths stay prose", async () => {
    // MUTATION-PROOF: loosen CONNECT_LINK_RE back to substring matching and
    // this fails — '?reconnect=gmail' would card Gmail and swallow the URL.
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "See https://app.example.com/w/ws1/connections?reconnect=gmail and https://app.example.com/w/ws1/connections/apps/gmail/settings",
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.form.blocks).toBeUndefined();
    expect(posted[0]!.form.text).toContain("reconnect=gmail");
  });

  it("lifts a markdown-form connect link out whole — no '[label]()' remnant", async () => {
    // MUTATION-PROOF: strip only the URL span and the prose keeps a broken
    // '[attach it here]()' skeleton.
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "You can [attach it here](https://app.example.com/w/ws1/connections/apps/google-calendar) once ready.",
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    const blocks = JSON.parse(posted[0]!.form.blocks!) as {
      type: string;
      text?: { text: string };
    }[];
    expect(blocks[0]?.text?.text).not.toContain("attach it here");
    expect(blocks[0]?.text?.text).not.toContain("()");
    expect(JSON.stringify(blocks)).toContain("Google Calendar");
  });

  it("chunks long prose into 3,000-char-safe sections instead of losing the post", async () => {
    // Slack caps a section's text at 3,000 chars and rejects the whole
    // message past it — invalid_blocks AFTER the cursor advanced would
    // silently drop the answer. MUTATION-PROOF: put the prose back into one
    // section block and the length assertion fails.
    const paragraph = `${"An answer long enough to overflow a single Slack section block. ".repeat(60)}\n`;
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        `${paragraph.repeat(2)}Attach it: https://app.example.com/w/ws1/connections/apps/google-calendar`,
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    const blocks = JSON.parse(posted[0]!.form.blocks!) as {
      type: string;
      text?: { text: string };
    }[];
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.text!.text.length).toBeLessThanOrEqual(3000);
    }
    expect(blocks.filter((b) => b.type === "actions")).toHaveLength(1);
  });

  it("posts a past-40k answer plain — the link scan stays inside mrkdwn's hostile-input fence", async () => {
    // MUTATION-PROOF: drop the length gate and this cards the link (blocks
    // defined) — and re-opens the quadratic-scan surface on unbounded input.
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        `${"x".repeat(40_001)} https://app.example.com/w/ws1/connections/apps/google-calendar`,
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.form.blocks).toBeUndefined();
  });

  it("degrades to the plain answer when escape expansion would crest Slack's block ceiling", async () => {
    // The mirror's 40k fence measures the INPUT, but the converter's
    // escaping expands `&` 5× — a sub-40k answer can convert to ~200k of
    // mrkdwn, whose section chunks plus card rows exceed 50 blocks and
    // Slack rejects the WHOLE post (invalid_blocks) after the cursor
    // advanced. MUTATION-PROOF: drop the block-budget fence in connectCards
    // and this posts blocks (and the answer would be lost for real).
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        `${"&".repeat(39_000)} https://app.example.com/w/ws1/connections/apps/google-calendar`,
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.form.blocks).toBeUndefined();
    // Any input tripping the block budget converted past 40k too, so the
    // plain fallback truncates (marked, under Slack's msg_too_long cap) — a
    // delivered prefix beats losing the whole answer to the rejection.
    // MUTATION-PROOF: drop the truncation and the length assertion fails
    // (~195k), which live would be msg_too_long — nothing delivered.
    expect(posted[0]!.form.text!.length).toBeLessThanOrEqual(39_050);
    expect(posted[0]!.form.text!.endsWith("… (truncated)")).toBe(true);
  });

  it("keeps the card post's notification text to one section — never the whole converted answer", async () => {
    // With blocks carrying the content, `text` is only the notification
    // fallback — past 40k it rejects the whole post (msg_too_long).
    // MUTATION-PROOF: put the full converted text back and the length
    // assertion fails.
    const paragraph = `${"A long answer that needs several section chunks to stay postable. ".repeat(90)}\n`;
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        `${paragraph}Attach it: https://app.example.com/w/ws1/connections/apps/google-calendar`,
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.form.blocks).toBeDefined();
    expect(posted[0]!.form.text!.length).toBeLessThanOrEqual(2900);
  });

  it("never cuts a section chunk inside a <url|label> token", async () => {
    // A converted link straddling the 2,900 chunk boundary would render as
    // literal angle-bracket soup in both halves. MUTATION-PROOF: drop the
    // open-token check in sectionChunks and the first chunk ends mid-token.
    const straddler = `${"x".repeat(2_880)} [click the long link](https://example.com/${"p".repeat(120)}) ${"y".repeat(3_000)}\nAttach: https://app.example.com/w/ws1/connections/apps/google-calendar`;
    const controlPlane = createFakeControlPlane(transcriptWith(straddler));

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    const blocks = JSON.parse(posted[0]!.form.blocks!) as {
      type: string;
      text?: { text: string };
    }[];
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      const text = section.text!.text;
      const lastOpen = text.lastIndexOf("<");
      if (lastOpen !== -1) {
        expect(text.indexOf(">", lastOpen)).toBeGreaterThan(lastOpen);
      }
    }
  });

  it("survives a connect link nested inside another connect link's markdown label", async () => {
    // The wrapper rewind makes the outer link's span start before the inner
    // link's end; the backwards slice must stay empty — no duplicated prose,
    // both providers carded once.
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "[see https://app.example.com/w/ws1/connections/apps/gmail](https://app.example.com/w/ws1/connections/apps/google-calendar)",
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    const blocks = JSON.parse(posted[0]!.form.blocks!) as { type: string }[];
    expect(blocks.filter((b) => b.type === "actions")).toHaveLength(2);
    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("Gmail");
    expect(rendered).toContain("Google Calendar");
    // No section repeats the answer's text — the spans never double-count.
    expect(rendered.match(/connections\/apps/g)).toBeNull();
  });

  it("joins the attach param with & when the chat URL already carries a query", async () => {
    const controlPlane = createFakeControlPlane(
      transcriptWith(
        "Attach: https://app.example.com/w/ws1/connections/apps/google-calendar",
      ),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
      chatUrl: "https://app.example.com/w/ws1/agents/ag1/chat?tab=chat",
    });

    const posted = slack.callsTo("chat.postMessage");
    const blocks = JSON.parse(posted[0]!.form.blocks!) as {
      type: string;
      elements?: { type: string; url?: string }[];
    }[];
    const button = blocks
      .filter((b) => b.type === "actions")
      .flatMap((b) => b.elements ?? [])
      .find((el) => el.type === "button");
    expect(button?.url).toBe(
      "https://app.example.com/w/ws1/agents/ag1/chat?tab=chat&attach=google-calendar",
    );
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
      ":calendar: Scheduled run **daily** &lt;sweep&gt;\n*Inbox*\n• *unread:* 0",
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
      ":calendar: Scheduled run **daily** &lt;sweep&gt;",
    ]);
  });

  it("captions an automation with ONE line, never its whole run instruction", async () => {
    // THE LIVE FAILURE (2026-08-31): a watch fire's `turn.message` is the
    // platform's run INSTRUCTION — header, then the agent's own stored
    // prompt, then a recent-output excerpt — and Slack printed all of it as
    // the caption. Readers saw "finish with a SHORT report", cleanup
    // commands, and a dozen excerpt lines presented as the agent's words.
    // MUTATION-PROOF: pass `input.title` straight through and the prompt
    // body and excerpt come back.
    const controlPlane = createFakeControlPlane(
      transcriptWith("CI passed on #1004."),
    );

    await mirror({
      controlPlane,
      workItem: item({
        source: "watch",
        userId: null,
        message: [
          '[Watch on process "CI watcher PR 1004" fired: its output matched.]',
          "",
          "Run tail -5 /tmp/ci1004.log for the result.",
          "Then clean up: rm -rf /tmp/ocl3 /tmp/ci1004.*",
          "",
          "[Recent output:]",
          "RUNNING CI",
          "RUNNING CI",
        ].join("\n"),
      }),
    });

    const [posted] = slack.callsTo("chat.postMessage");
    const text = posted?.form.text ?? "";
    // The caption survives — two automations in one thread must stay
    // distinguishable — but only its first line.
    expect(text).toContain("CI watcher PR 1004");
    // None of the instruction body reaches the channel.
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain("RUNNING CI");
    expect(text).not.toContain("Recent output");
    // The agent's actual report still posts, converted, below the caption.
    expect(text).toContain("CI passed on #1004.");
  });

  it("chunks a long automation report instead of losing the post", async () => {
    // Slack caps a section at 3,000 chars and rejects the WHOLE post past
    // it — after the cursor advanced, which would silently drop the report.
    // MUTATION-PROOF: pass the body as ONE section and this fails.
    const controlPlane = createFakeControlPlane(
      transcriptWith("word ".repeat(2_000)),
    );

    await mirror({
      controlPlane,
      workItem: item({
        source: "cron",
        userId: null,
        message: 'Scheduled run "big"',
      }),
    });

    const posted = slack.callsTo("chat.postMessage")[0];
    const blocks = JSON.parse(posted?.form.blocks ?? "[]") as {
      type: string;
      text?: { text: string };
    }[];
    expect(blocks[0]?.type).toBe("context");
    const sections = blocks.filter((block) => block.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect((section.text?.text ?? "").length).toBeLessThanOrEqual(3_000);
    }
  });

  it("clips an over-long single-line caption instead of letting it run", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith("Done."));

    await mirror({
      controlPlane,
      workItem: item({
        source: "cron",
        userId: null,
        message: `Scheduled run "${"very-long-name ".repeat(20)}"`,
      }),
    });

    const caption = (slack.callsTo("chat.postMessage")[0]?.form.text ?? "")
      .split("\n")[0]!
      // Strip the icon to measure the caption itself.
      .replace(/^:calendar: /, "");
    expect(caption.length).toBeLessThanOrEqual(121);
    expect(caption.endsWith("…")).toBe(true);
  });

  it("posts the answer, not the narration, from a real multi-message turn", async () => {
    // END TO END for "the answer is the last message" (supervisor,
    // 2026-08-31). The transcript here is the shape a working turn actually
    // produces: narration, a tool batch whose output is huge (the
    // `RUNNING CI` flood from the reported screenshot), then the closing
    // message.
    //
    // MUTATION-PROOF on the rule that matters: make the outcome reader
    // ACCUMULATE text events instead of last-wins and this fails. (Tool
    // output reaching `text` is covered by construction — the closing
    // message arrives after the tool and would overwrite it either way —
    // so the tool assertion below is a guard, not the pin.)
    const controlPlane = createFakeControlPlane({
      readTranscript: async () => ({
        events: [
          { seq: 1, turnId: "t1", type: "turn.started", payload: {} },
          {
            seq: 2,
            turnId: "t1",
            type: "text",
            payload: { text: "Let me check the CI logs." },
          },
          {
            seq: 3,
            turnId: "t1",
            type: "tool.started",
            payload: { callId: "c1", name: "bash" },
          },
          {
            seq: 4,
            turnId: "t1",
            type: "tool.finished",
            payload: {
              callId: "c1",
              name: "bash",
              output: "RUNNING CI\n".repeat(12),
            },
          },
          {
            seq: 5,
            turnId: "t1",
            type: "text",
            payload: { text: "CI passed on #1004; ready for review." },
          },
          { seq: 6, turnId: "t1", type: "turn.done", payload: {} },
        ],
        nextSince: 7,
        hasMore: false,
      }),
    });

    await mirror({ controlPlane, workItem: item({ source: "web" }) });

    const posted = slack
      .callsTo("chat.postMessage")
      .map((call) => call.form.text);
    // Two posts: the attributed web question, then the answer — the LAST
    // text event, alone.
    expect(posted.at(-1)).toBe("CI passed on #1004; ready for review.");
    expect(posted.at(-1)).not.toContain("Let me check");
    expect(posted.at(-1)).not.toContain("RUNNING CI");
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

  it("answers a DM THREAD inside that thread", async () => {
    // THE BUG THIS FIXES (live): a reply typed in a DM thread was answered
    // at the bottom of the DM, outside the thread the person was reading.
    // The link says "D100, top-level" for every thread in the DM, so the
    // TURN's own arrival address is what puts the answer in the right place.
    //
    // MUTATION-PROOF: mirror through `replyTargetForLink` and this fails.
    const controlPlane = createFakeControlPlane(transcriptWith("Done."));

    await mirror({
      controlPlane,
      workItem: item({ source: "slack", sourceThreadId: "1699.123" }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.form.channel).toBe("D100");
    expect(posted[0]!.form.thread_ts).toBe("1699.123");
  });

  it("keeps a top-level DM answer top-level", async () => {
    // The other half of the same rule: an unthreaded DM must NOT gain a
    // thread it never had.
    const controlPlane = createFakeControlPlane(transcriptWith("Done."));

    await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect("thread_ts" in posted[0]!.form).toBe(false);
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

  it("posts the trial-credit card — headline, context line, and an add-key button", async () => {
    // The no-model-key family with a sharper verb: the agent was running on
    // OneCLI's free credit and it ran out — there is no user key to check,
    // the fix is ADDING one. Keyed on the CODE, gated on having a URL.
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      modelsUrl: "https://app.example.com/w/ws1/agents/ag1/models",
      workItem: item({
        source: "slack",
        error: "Trial credit is <done>.",
        errorCode: "trial_credit_exhausted",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("Trial credit is &lt;done&gt;.");
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
    expect(blocks[0]?.text?.text).toBe("*The free trial credit is used up*");
    const button = blocks.find((b) => b.type === "actions")?.elements?.[0];
    expect(button?.url).toBe("https://app.example.com/w/ws1/agents/ag1/models");
    expect(button?.action_id).toBe("open_models_page");
    expect(button?.text?.text).toBe("Add a model key");
  });

  it("trial-credit degrades to the plain answer when no models URL is configured", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      workItem: item({
        source: "slack",
        error: "Trial credit is <done>.",
        errorCode: "trial_credit_exhausted",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("Trial credit is &lt;done&gt;.");
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

  it("posts nothing for a DONE turn with neither answer nor error, but still advances", async () => {
    // Silence is only legal for a clean turn that genuinely said nothing —
    // a terminal failure always posts (the suite below).
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    const next = await mirror({
      controlPlane,
      workItem: item({ source: "slack" }),
    });

    expect(slack.calls).toEqual([]);
    expect(next).toBe("2026-08-06T10:00:00.000Z");
  });
});

describe("failure surfacing — never silent on a terminal outcome", () => {
  /** A transcript holding arbitrary events for t1. */
  const transcriptOf = (
    events: { type: string; payload: unknown }[],
  ): Pick<ControlPlaneClient, "readTranscript"> => ({
    readTranscript: async () => ({
      events: events.map((event, index) => ({
        seq: index + 1,
        turnId: "t1",
        ...event,
      })),
      nextSince: events.length + 1,
      hasMore: false,
    }),
  });

  it("a FAILED turn with nothing anywhere posts the canonical failure line", async () => {
    // The incident's exact shape: uncoded failure, error NULL, no text —
    // six messages died with the seen-reaction stripped and total silence.
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    const next = await mirror({
      controlPlane,
      workItem: item({ source: "slack", status: "failed" }),
    });

    expect(next).toBe("2026-08-06T10:00:00.000Z");
    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toContain(":warning:");
    expect(posted[0]?.form.text).toContain(
      "Something went wrong and this message didn",
    );
  });

  it("a FAILED turn with only a transcript error event posts that message", async () => {
    // Uncoded harness failures leave their text ONLY in the durable error
    // event (the supervisor sends no turn.result error for them) — the
    // mirror must read it, like the web's transcript fold does.
    const controlPlane = createFakeControlPlane(
      transcriptOf([
        { type: "error", payload: { message: "the harness said why" } },
      ]),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack", status: "failed" }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toContain("the harness said why");
    // The message IS the failure — no extra line after it.
    expect(posted[0]?.form.text).not.toContain(":warning:");
  });

  it("turn.error outranks the transcript error event — canonical copy wins", async () => {
    const controlPlane = createFakeControlPlane(
      transcriptOf([
        { type: "error", payload: { message: "raw vendor wording" } },
      ]),
    );

    await mirror({
      controlPlane,
      workItem: item({
        source: "slack",
        status: "failed",
        error: "The canonical sentence.",
      }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toContain("The canonical sentence.");
    expect(posted[0]?.form.text).not.toContain("raw vendor wording");
  });

  it("a FAILED turn with partial answer text posts the text AND the failure line", async () => {
    // A partial answer must never masquerade as a normal reply.
    const controlPlane = createFakeControlPlane(
      transcriptWith("Half an answer before it fell over"),
    );

    await mirror({
      controlPlane,
      workItem: item({ source: "slack", status: "failed" }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(2);
    expect(posted[0]?.form.text).toContain("Half an answer");
    expect(posted[1]?.form.text).toContain(":warning:");
    expect(posted[1]?.form.text).toContain("stopped partway");
  });

  it("an ABORTED turn with nothing posts the web's quiet closure word", async () => {
    const controlPlane = createFakeControlPlane(transcriptWith(null));

    await mirror({
      controlPlane,
      workItem: item({ source: "slack", status: "aborted" }),
    });

    const posted = slack.callsTo("chat.postMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.form.text).toBe("_Stopped._");
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
