import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AdapterPresence } from "@onecli/agent-protocol";
import { APPROVAL_GROUP_MAX_IDS } from "@onecli/channels";
import type { ControlPlaneClient } from "./control-plane";
import {
  ApprovalsAuthError,
  createApprovalsManager,
  fetchPendingApprovals,
  type PendingApproval,
} from "./approvals";
import { approvalCardBlocks, slackApprovalCardUi } from "./slack/approval-card";
import { botTokenOf } from "./slack/credentials";
import { unpackThreadAddress } from "@onecli/channels/slack";
import {
  createFakeControlPlane,
  settle,
  startFakeGatewayServer,
  startFakeSlackServer,
  waitReal,
  type FakeGatewayServer,
  type FakeSlackServer,
} from "./test/fakes";

/**
 * The approvals surface against a fake gateway (a real node:http server that
 * HOLDS requests once its script runs out — the long-poll, which is also
 * what paces the loop in tests) plus a fake control plane and Slack server.
 *
 * Where a test needs the loop's own sleeps (the 60s auth backoff, the 5s
 * expiry sweep) it fakes ONLY the timer families and advances them by hand;
 * setImmediate stays real so HTTP keeps flowing and `waitReal` keeps working.
 */

const TIMER_FAMILIES = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

let gateway: FakeGatewayServer;
let slack: FakeSlackServer;
let managers: ReturnType<typeof createApprovalsManager>[];

beforeEach(async () => {
  gateway = await startFakeGatewayServer();
  slack = await startFakeSlackServer();
  process.env.SLACK_API_BASE_URL = slack.url;
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) manager.stop();
  vi.useRealTimers();
  delete process.env.SLACK_API_BASE_URL;
  await gateway.close();
  await slack.close();
});

const presence = (
  overrides: Partial<AdapterPresence> = {},
): AdapterPresence => ({
  presenceId: "p1",
  provider: "slack",
  transport: "socket",
  status: "active",
  externalId: "B123",
  identityRef: null,
  agent: { id: "ag1", name: "Deploy Agent", workspaceId: "proj1" },
  tenant: { externalId: "T1", name: "Acme" },
  credentialsJson: JSON.stringify({ botToken: "xoxb-bot" }),
  approvalsKey: "svc-key-1",
  links: [
    {
      id: "l1",
      conversationId: "cv1",
      externalThreadId: "D100",
      kind: "direct",
      externalUserId: "U1",
      mirrorCursor: null,
    },
  ],
  ...overrides,
});

const pendingBody = (id: string, expiresAt?: string): unknown => ({
  requests: [
    {
      id,
      method: "POST",
      host: "api.example.com",
      path: "/v1/emails",
      summary: {
        action: "Send an email",
        details: [{ label: "To", value: "a@example.com" }],
      },
      agent: { id: "ag1", name: "Deploy Agent" },
      ...(expiresAt && { expiresAt }),
    },
  ],
});

/** The control plane's ledger still holding these cards pending: nothing
 * in the channel has decided them, so an absence or a passed deadline is
 * the adapter's to settle. */
const ledgerPending =
  (...approvalIds: string[]): ControlPlaneClient["listUnsettledPrompts"] =>
  async () =>
    approvalIds.map((approvalId) => ({
      approvalId,
      agentChannelId: "p1",
      externalThreadId: "D100",
      externalMessageRef: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    }));

const makeManager = (
  controlPlane: ControlPlaneClient,
  overrides: { pacingMs?: number } = {},
) => {
  // The REAL Slack card implementation rides the fake HTTP server — the
  // manager itself is channel-general and only sees the seam.
  const manager = createApprovalsManager({
    controlPlane,
    gatewayUrl: gateway.url,
    approvalsPollSeconds: 1,
    cardUiOf: () => slackApprovalCardUi,
    threadAddressOf: () => unpackThreadAddress,
    credentialOf: botTokenOf,
    // Real pacing is 3s; tests pace in tens of ms like the other cadences.
    pacingMs: overrides.pacingMs ?? 25,
    onLog: () => {},
  });
  managers.push(manager);
  return manager;
};

describe("fetchPendingApprovals", () => {
  it("presents the presence's service key and the exclude list", async () => {
    gateway.script.push({ status: 200, body: pendingBody("app-1") });

    const pending = await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: ["a", "b c"],
      timeoutMs: 5_000,
    });

    expect(pending.map((request) => request.id)).toEqual(["app-1"]);
    expect(gateway.calls[0]).toEqual({
      path: "/v1/approvals/pending",
      token: "svc-key-1",
      exclude: ["a", "b c"],
    });
  });

  it("sends no exclude param when nothing is tracked", async () => {
    gateway.script.push({ status: 200, body: { requests: [] } });

    await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: [],
      timeoutMs: 5_000,
    });

    expect(gateway.calls[0]?.exclude).toEqual([]);
  });

  it.each([401, 403])(
    "turns a %d into an ApprovalsAuthError",
    async (status) => {
      gateway.script.push({ status, body: { error: "nope" } });

      await expect(
        fetchPendingApprovals({
          gatewayUrl: gateway.url,
          serviceKey: "svc-key-1",
          excludeIds: [],
          timeoutMs: 5_000,
        }),
      ).rejects.toBeInstanceOf(ApprovalsAuthError);
    },
  );

  it("keeps a 5xx an ordinary (retryable) error, NOT an auth error", async () => {
    // The distinction is load-bearing: auth errors back off for a minute and
    // flag the presence; transport blips retry in seconds and stay quiet.
    gateway.script.push({ status: 500, body: {} });

    const error: unknown = await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: [],
      timeoutMs: 5_000,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApprovalsAuthError);
  });

  it("keeps a detail's record link only when it is https, for every channel", async () => {
    const urls = [
      "https://acme.my.salesforce.com/001QO000010eH0cYAF",
      "javascript:alert(1)",
      "http://acme.my.salesforce.com/x",
      "not a url",
    ];
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          {
            id: "app-1",
            summary: {
              action: "Create Contact",
              details: urls.map((url) => ({
                label: "Account",
                value: "Initech",
                url,
              })),
            },
          },
        ],
      },
    });

    const [pending] = await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: [],
      timeoutMs: 5_000,
    });

    // An unsafe link is dropped, never fatal: the row still renders.
    expect(pending?.summary?.details?.map((d) => d.url)).toEqual([
      urls[0],
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("keeps and links every record-page shape the gateway builds", async () => {
    // One per gateway template (`summary::record_links`): each must survive
    // the channel-neutral https check and render as a Slack link, a `?` and
    // `=` included (Drive's opener).
    const recordPages = [
      "https://github.com/acme/web/issues/42",
      "https://www.notion.so/0123456789abcdef0123456789abcdef",
      "https://trello.com/c/5f1a2b3c4d5e6f7a8b9c0d1e",
      "https://app.todoist.com/app/task/6Xm2Pq9RtV4wZc8K",
      "https://docs.google.com/spreadsheets/d/1SheetId_42/edit",
      "https://drive.google.com/open?id=1AbCdEf98765",
    ];
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          {
            id: "app-2",
            summary: {
              action: "PATCH request",
              details: recordPages.map((url) => ({
                label: "Record",
                value: "it",
                url,
              })),
            },
          },
        ],
      },
    });

    const [pending] = await fetchPendingApprovals({
      gatewayUrl: gateway.url,
      serviceKey: "svc-key-1",
      excludeIds: [],
      timeoutMs: 5_000,
    });
    expect(pending?.summary?.details?.map((d) => d.url)).toEqual(recordPages);
    const card = JSON.stringify(approvalCardBlocks(pending!));
    for (const url of recordPages) expect(card).toContain(`<${url}|it>`);
  });
});

describe("the approval card", () => {
  const approval: PendingApproval = {
    id: "app-7",
    method: "POST",
    host: "api.example.com",
    path: "/v1/emails",
    summary: {
      action: "<!here> Send email",
      details: [{ label: "To<", value: "x&y" }],
    },
    agent: { id: "ag1", name: "Bot <b>" },
    expiresAt: undefined,
  };

  it("escapes every dynamic field — cards must not ping the workspace either", () => {
    const blocks = approvalCardBlocks(approval);
    // The action title rides the header block, which is plain_text — Slack
    // renders it literally and never parses pings there. Every mrkdwn field
    // (where <!here> WOULD ping) must carry only escaped text.
    const mrkdwnTexts = JSON.stringify(
      blocks.flatMap((b) => {
        const block = b as {
          type: string;
          text?: { type: string; text: string };
          elements?: { type: string; text: string }[];
        };
        return [
          ...(block.text?.type === "mrkdwn" ? [block.text.text] : []),
          ...(block.elements ?? [])
            .filter((e) => e.type === "mrkdwn")
            .map((e) => e.text),
        ];
      }),
    );
    expect(mrkdwnTexts).not.toContain("<!here>");
    expect(mrkdwnTexts).toContain("Bot &lt;b&gt;");
    expect(mrkdwnTexts).toContain("To&lt;");
    expect(mrkdwnTexts).toContain("x&amp;y");
    // And the header really is plain_text (the no-parse guarantee).
    const header = blocks[0] as { type: string; text: { type: string } };
    expect(header.type).toBe("header");
    expect(header.text.type).toBe("plain_text");
  });

  it("links a detail to its record page, unless the URL could break Slack's link syntax", () => {
    const withLinks = (url: string) =>
      JSON.stringify(
        approvalCardBlocks({
          ...approval,
          summary: {
            action: "Create Contact",
            details: [{ label: "Account", value: "Initech (001QO…)", url }],
          },
        }),
      );
    expect(
      withLinks("https://acme.my.salesforce.com/001QO000010eH0cYAF"),
    ).toContain(
      "<https://acme.my.salesforce.com/001QO000010eH0cYAF|Initech (001QO…)>",
    );
    for (const bad of [
      "https://a.test/x|<!here>",
      "https://a.test/x>y",
      "https://a.test/x y",
    ]) {
      const rendered = withLinks(bad);
      expect(rendered, bad).not.toContain("<https");
      expect(rendered, bad).toContain("Initech (001QO…)");
    }
  });

  it("falls back to method/host/path when the gateway sent no summary", () => {
    const rendered = JSON.stringify(
      approvalCardBlocks({ ...approval, summary: null }),
    );
    expect(rendered).toContain("POST api.example.com/v1/emails");
  });

  it("says undecided-means-denied when there is no expiry", () => {
    const rendered = JSON.stringify(approvalCardBlocks(approval));
    expect(rendered).toContain("Undecided means denied.");
  });

  it("clamps an oversized detail value (and the header action) with a trailing ellipsis", () => {
    // The gateway's summary fields are unbounded; a Slack section block caps
    // at 3,000 chars and a header block at 150. clampDetail keeps each
    // dynamic field ≤200+ellipsis and clampHeader keeps the action ≤120 so
    // the card always posts — delete either clamp and a long enough value
    // kills the entire post with invalid_blocks, silencing the approval.
    const rendered = JSON.stringify(
      approvalCardBlocks({
        ...approval,
        summary: {
          action: "t".repeat(300),
          details: [{ label: "Body", value: "v".repeat(300) }],
        },
      }),
    );
    expect(rendered).toContain(`${"v".repeat(200)}…`);
    expect(rendered).not.toContain("v".repeat(201));
    expect(rendered).toContain(`${"t".repeat(120)}…`);
    expect(rendered).not.toContain("t".repeat(121));
  });

  it("keeps the details section under Slack's cap even when escaping expands every char", () => {
    // '<' escapes 4x, so clamping BEFORE escaping would land ~800 chars per
    // field and a few bracket-heavy details would blow the 3,000-char
    // section cap — invalid_blocks, and a claimed card that never posts.
    // Clamp-after-escape plus the joined budget keep the post alive and say
    // what was dropped instead of truncating silently.
    const blocks = approvalCardBlocks({
      ...approval,
      summary: {
        action: "Send an email",
        details: Array.from({ length: 8 }, () => ({
          label: "<".repeat(300),
          value: "<".repeat(300),
        })),
      },
    });
    const section = (blocks[1] as { text: { text: string } }).text.text;
    expect(section.length).toBeLessThanOrEqual(3_000);
    // Whole lines past the budget are dropped, and the drop is said aloud.
    expect(section).toMatch(/>_\+\d more_$/);
    expect(section).not.toContain("<".repeat(2));
  });
});

describe("posting a card", () => {
  const cardBlocksSchema = z.array(z.looseObject({ type: z.string() }));
  const actionsSchema = z.looseObject({
    type: z.literal("actions"),
    elements: z.array(
      z.looseObject({ action_id: z.string(), value: z.string() }),
    ),
  });

  it("claims FIRST, posts the card with ONLY the opaque approval id in the buttons, and records the ref", async () => {
    // Two laws in one flow. Claim-before-post is the restart/twin dedupe.
    // And the buttons carry the approval id and NOTHING else — anything
    // richer would move server state into a client payload (Slack caps
    // `value` at 2000 chars, and the id is the whole authority a click may
    // carry; the control plane authorizes the clicker server-side).
    const order: string[] = [];
    const claims: unknown[] = [];
    const records: [string, string][] = [];
    slack.onCall = (call) => order.push(`slack:${call.method}`);
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        order.push("claim");
        claims.push(input);
        return true;
      },
      recordPromptMessage: async (approvalId, ref) => {
        records.push([approvalId, ref]);
      },
    });
    gateway.script.push({ status: 200, body: pendingBody("app-42") });

    makeManager(controlPlane).reconcile([presence()]);
    // The loop re-polling (and being held) proves the whole postCard ran.
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(order).toEqual(["claim", "slack:chat.postMessage"]);
    // The claim now carries the gateway deadline (null here — this pending body
    // has no expiry) so a restart can re-arm against the REAL deadline.
    expect(claims).toEqual([
      {
        approvalId: "app-42",
        presenceId: "p1",
        externalThreadId: "D100",
        expiresAt: null,
      },
    ]);

    const card = slack.callsTo("chat.postMessage")[0]!;
    expect(card.token).toBe("xoxb-bot");
    expect(card.form.channel).toBe("D100");
    // No avatar on this presence — no icon_url key on the card either.
    expect("icon_url" in card.form).toBe(false);
    const blocks = cardBlocksSchema.parse(JSON.parse(card.form.blocks!));
    const actions = actionsSchema.parse(
      blocks.find((block) => block.type === "actions"),
    );
    expect(actions.elements.map((el) => el.action_id)).toEqual([
      "channel_approve",
      "channel_deny",
    ]);
    expect(actions.elements.map((el) => el.value)).toEqual([
      "app-42",
      "app-42",
    ]);

    expect(records).toEqual([
      [
        "app-42",
        `${String(card.response.channel)}:${String(card.response.ts)}`,
      ],
    ]);
    // No exclude list — the full pending set is the cross-surface sync
    // signal (an absent tracked id means "decided elsewhere").
    expect(gateway.calls[1]?.exclude).toEqual([]);
  });

  it("carries the agent's avatar as icon_url on the card when the feed serves one", async () => {
    const controlPlane = createFakeControlPlane({
      claimPrompt: async () => true,
      recordPromptMessage: async () => {},
    });
    gateway.script.push({ status: 200, body: pendingBody("app-43") });

    makeManager(controlPlane).reconcile([
      presence({
        agent: {
          id: "ag1",
          name: "Deploy Agent",
          workspaceId: "proj1",
          imageUrl: "https://api.example.com/v1/agent-images/ag1/abc",
        },
      }),
    ]);
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(slack.callsTo("chat.postMessage")[0]!.form.icon_url).toBe(
      "https://api.example.com/v1/agent-images/ag1/abc",
    );
  });

  it("posts NO card when the claim is lost", async () => {
    // MUTATION-PROOF: the claim is the restart/twin dedupe — delete the
    // `if (!claimed) return` in postCard and a restarted adapter (or a
    // deploy-overlap twin) posts a second card for the same approval.
    const claims: unknown[] = [];
    const records: unknown[] = [];
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        claims.push(input);
        return false;
      },
      recordPromptMessage: async (approvalId, ref) => {
        records.push([approvalId, ref]);
      },
    });
    gateway.script.push({ status: 200, body: pendingBody("app-42") });

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(claims).toHaveLength(1);
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
    expect(records).toEqual([]);
  });

  it("posts NO card for another agent's approval — the pending set is workspace-wide, the DM is one agent's", async () => {
    // The gateway scopes /v1/approvals/pending to the WORKSPACE, so Martin's
    // poll also sees Donna's approval. Without the agent fence the first
    // presence to claim posts it — Donna's card in Martin's DM.
    const claims: unknown[] = [];
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        claims.push(input);
        return true;
      },
      recordPromptMessage: async () => {},
    });
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          {
            id: "app-donna",
            method: "POST",
            host: "www.googleapis.com",
            path: "/calendar/v3/events",
            summary: { action: "Update calendar event", details: [] },
            agent: { id: "ag-donna", name: "Donna" },
          },
        ],
      },
    });

    // Martin's presence polls; the sole pending approval is Donna's.
    makeManager(controlPlane).reconcile([
      presence({
        agent: { id: "ag-martin", name: "Martin", workspaceId: "proj1" },
      }),
    ]);
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(claims).toEqual([]);
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
  });

  it("still posts an agent-less approval (older gateway) — the fence must not silence it", async () => {
    const controlPlane = createFakeControlPlane({
      claimPrompt: async () => true,
      recordPromptMessage: async () => {},
    });
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          {
            id: "app-legacy",
            method: "POST",
            host: "api.example.com",
            path: "/v1/emails",
            summary: { action: "Send an email", details: [] },
          },
        ],
      },
    });

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
  });
});

describe("gateway auth health", () => {
  it("reports unhealthy ONCE across repeated 401 polls, and healthy again on recovery", async () => {
    // Flap suppression: the report fires on the TRANSITION, not per poll.
    // MUTATION-PROOF: remove the `healthy` latch and the middle section
    // sees a second ["p1", false] report for the second 401.
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES] });
    const reports: [string, boolean][] = [];
    const controlPlane = createFakeControlPlane({
      reportApprovalHealth: async (presenceId, healthy) => {
        reports.push([presenceId, healthy]);
      },
    });
    gateway.script.push(
      { status: 401, body: {} },
      { status: 401, body: {} },
      { status: 200, body: { requests: [] } },
    );

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => reports.length === 1, "first unhealthy report");
    expect(reports).toEqual([["p1", false]]);

    // Wait for the loop to park on its 60s backoff (expiry interval + sleep
    // = two fake timers), then release it into the second 401.
    await waitReal(() => vi.getTimerCount() >= 2, "parked on the backoff");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => gateway.calls.length >= 2, "second poll");
    await settle();
    expect(reports).toEqual([["p1", false]]);

    // The healthy poll flips it back — exactly once.
    await waitReal(() => vi.getTimerCount() >= 2, "parked again");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => reports.length === 2, "healthy report");
    expect(reports[1]).toEqual(["p1", true]);
  });
});

describe("expiry", () => {
  it("settles an expired prompt and rewrites the card as timed out", async () => {
    // REAL timers throughout: the sweep is driven directly via the manager's
    // own `sweepExpired` handle. The old version faked the clock and advanced
    // into the 5s interval — but faking global timers around live HTTP hangs
    // undici on CI's Node (the card post to the fake Slack server never
    // completed), which is exactly the flake this replaced. The interval's
    // wiring is pinned by the health test's fake-timer count.
    const settles: [string, string][] = [];
    const recorded: string[] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      recordPromptMessage: async (approvalId) => {
        recorded.push(approvalId);
      },
      listUnsettledPrompts: ledgerPending("app-9"),
    });
    const past = new Date(Date.now() - 1_000).toISOString();
    gateway.script.push({ status: 200, body: pendingBody("app-9", past) });

    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    // Wait for the RECORD step — the point where the prompt is fully tracked
    // (waiting on the server-side post count races the response leg).
    await waitReal(() => recorded.length === 1, "card posted and recorded");
    const card = slack.callsTo("chat.postMessage")[0]!;

    await manager.sweepExpired();
    expect(settles).toEqual([["app-9", "expired"]]);

    await waitReal(
      () => slack.callsTo("chat.update").length === 1,
      "card rewritten",
    );
    const update = slack.callsTo("chat.update")[0]!;
    expect(update.form.ts).toBe(card.response.ts);
    // The record keeps WHAT was asked and states the outcome.
    expect(update.form.text).toBe(
      "Send an email · Expired (no response) · denied",
    );
  });
});

describe("settleDecided", () => {
  it("rewrites a card whose approval vanished from the pending set (decided on the web)", async () => {
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      // The dashboard decides at the gateway and never touches the ledger.
      listUnsettledPrompts: ledgerPending("app-42"),
    });
    // Poll 1 posts the card; poll 2 serves an EMPTY set — the approval was
    // decided elsewhere, and the card must follow without a Slack click.
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    gateway.script.push({ status: 200, body: { requests: [] } });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    // The ledger settles AFTER the card rewrite lands (card-first order), so
    // the ledger write is the "whole pair ran" signal to wait on.
    await waitReal(() => settles.length >= 1, "card settled from the poll");

    expect(settles).toContainEqual(["app-42", "decided"]);
    const update = slack.callsTo("chat.update")[0]!;
    expect(update.form.text).toBe("Send an email · Decided from the dashboard");
  });

  it("keeps the prompt tracked when the rewrite fails — ledger untouched, retried on the next poll", async () => {
    // Card FIRST, ledger second, untrack last: once the ledger says
    // "decided" no instance ever rewrites this card again, so a failed
    // chat.update must leave the ledger alone and the prompt tracked — the
    // absence persists into the next poll, which retries the pair.
    // MUTATION-PROOF: restore the old order (delete + settle before the
    // rewrite, or a swallowed update error) and the failed update below
    // still records a settle — the ledger-untouched assertion fails.
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: ledgerPending("app-42"),
    });
    let failUpdates = true;
    slack.respond("chat.update", (form) =>
      failUpdates
        ? { ok: false, error: "msg_too_long" }
        : { ok: true, ts: form.ts ?? "0.0" },
    );
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    gateway.script.push({ status: 200, body: { requests: [] } }); // rewrite fails

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(
      () => slack.callsTo("chat.update").length >= 1,
      "first rewrite attempted",
    );
    expect(settles).toEqual([]);

    // Heal the update and answer the re-armed long-poll(s) with the same
    // absence — the retry settles the whole pair.
    failUpdates = false;
    await waitReal(() => {
      gateway.releaseHeld(200, { requests: [] });
      return settles.length === 1;
    }, "retry settled the pair");
    expect(settles).toEqual([["app-42", "decided"]]);
    expect(slack.callsTo("chat.update").length).toBeGreaterThanOrEqual(2);
  });

  it("rewrites the tracked card with the decision text, once", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "card posted");
    const card = slack.callsTo("chat.postMessage")[0]!;

    await manager.settleDecided("app-42", "✅ Approved by Ada");

    const updates = slack.callsTo("chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form.ts).toBe(card.response.ts);
    expect(updates[0]?.form.text).toBe("Send an email · ✅ Approved by Ada");

    // The ledger entry is consumed — a second settle touches nothing.
    await manager.settleDecided("app-42", "again?");
    expect(slack.callsTo("chat.update")).toHaveLength(1);
  });

  it("skips the absence settle while a channel-click decision is in flight", async () => {
    // The click path removes the approval from the gateway's pending set via
    // decide() BEFORE settleDecided rewrites the card; an unfenced poll in
    // that window would win the rewrite with the wrong provenance
    // ("Decided from the dashboard" for a click made right here).
    // MUTATION-PROOF: drop the `deciding` fence in the absence arm and the
    // dashboard text lands below instead of the approved text.
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
    });
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "second poll held");

    // The click lands: the decision round-trip begins, and the approval
    // vanishes from the pending set the next poll serves.
    manager.beginDecision("app-42");
    gateway.releaseHeld(200, { requests: [] });
    await settle();
    expect(settles).toEqual([]);
    expect(slack.callsTo("chat.update")).toEqual([]);

    // The round-trip completes with the real outcome.
    await manager.settleDecided("app-42", "✅ Approved by Ada");
    manager.endDecision("app-42");
    const updates = slack.callsTo("chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form.text).toBe("Send an email · ✅ Approved by Ada");
  });

  it("treats a permanently-gone card as settled — a deleted message must not retry forever", async () => {
    // An admin deleted the bot's card message: chat.update answers
    // message_not_found on every attempt, permanently. The card cannot
    // mislead anyone if it no longer exists, so the settle proceeds (ledger
    // written, prompt untracked) instead of wedging the 5s sweep and the
    // poll's absence arm in an infinite retry.
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: ledgerPending("app-42"),
    });
    slack.respond("chat.update", () => ({
      ok: false,
      error: "message_not_found",
    }));
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    gateway.script.push({ status: 200, body: { requests: [] } });

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => settles.length === 1, "settled past the gone card");
    expect(settles).toEqual([["app-42", "decided"]]);
  });
});

describe("a card a channel click already settled", () => {
  // An events-transport click is decided control-plane-side: it rewrites the
  // card itself ("✅ Approved by …" via response_url) and settles the
  // ledger, and this adapter is never told. Live 2026-10-03: the absence
  // arm then rewrote all four of a person's Slack approvals as "Decided
  // from the dashboard".

  it("is never rewritten when its approval leaves the pending set", async () => {
    // MUTATION-PROOF: drop the ledger check from the absence arm and the
    // dashboard rewrite (and a second ledger settle) lands below.
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: ledgerPending(),
    });
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "second poll held");

    gateway.releaseHeld(200, { requests: [] });
    await waitReal(() => gateway.calls.length >= 3, "absence handled");

    expect(slack.callsTo("chat.update")).toEqual([]);
    expect(settles).toEqual([]);
  });

  it("is never rewritten as expired once its deadline passes", async () => {
    // A clicked card left tracked would be rewritten "Expired" by the sweep
    // at its deadline. MUTATION-PROOF: drop the ledger check from the sweep
    // and the expiry rewrite lands below; keep the card tracked instead of
    // untracking it and the second sweep asks the ledger again.
    const settles: [string, string][] = [];
    const recorded: string[] = [];
    let ledgerReads = 0;
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      recordPromptMessage: async (approvalId) => {
        recorded.push(approvalId);
      },
      listUnsettledPrompts: async () => {
        ledgerReads += 1;
        return ledgerPending()();
      },
    });
    const past = new Date(Date.now() - 1_000).toISOString();
    gateway.script.push({ status: 200, body: pendingBody("app-9", past) });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(() => recorded.length === 1, "card posted and recorded");

    await manager.sweepExpired();
    await manager.sweepExpired();

    expect(slack.callsTo("chat.update")).toEqual([]);
    expect(settles).toEqual([]);
    // Untracked, not merely skipped: the second sweep had nothing to ask.
    expect(ledgerReads).toBe(1);
  });

  it("keeps a socket click's card tracked while its decision round-trips", async () => {
    // A socket click is decided by the same control-plane call, which
    // settles the ledger BEFORE settleDecided rewrites the card. A sweep in
    // that window sees "settled" and must leave the prompt alone, or the
    // card loses its real outcome. MUTATION-PROOF: untrack regardless of
    // `deciding` in stillUnsettled and no rewrite lands below.
    const recorded: string[] = [];
    const controlPlane = createFakeControlPlane({
      recordPromptMessage: async (approvalId) => {
        recorded.push(approvalId);
      },
      listUnsettledPrompts: ledgerPending(),
    });
    const past = new Date(Date.now() - 1_000).toISOString();
    gateway.script.push({ status: 200, body: pendingBody("app-9", past) });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(() => recorded.length === 1, "card posted and recorded");

    manager.beginDecision("app-9");
    await manager.sweepExpired();
    await manager.settleDecided("app-9", "✅ Approved by Ada");
    manager.endDecision("app-9");

    const updates = slack.callsTo("chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form.text).toBe("Send an email · ✅ Approved by Ada");
  });

  it("stays tracked, untouched, while the ledger cannot be read", async () => {
    // An outage must not guess either way: no rewrite (it may be a click),
    // no untrack (it may not be). The next cadence retries.
    let ledgerUp = false;
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: async () => {
        if (!ledgerUp) throw new Error("control plane down");
        return ledgerPending("app-42")();
      },
    });
    gateway.script.push({ status: 200, body: pendingBody("app-42") });
    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "second poll held");

    gateway.releaseHeld(200, { requests: [] });
    await waitReal(() => gateway.calls.length >= 3, "absence handled");
    expect(slack.callsTo("chat.update")).toEqual([]);
    expect(settles).toEqual([]);

    // Recovered: the same absence now settles as before.
    ledgerUp = true;
    await waitReal(() => {
      gateway.releaseHeld(200, { requests: [] });
      return settles.length === 1;
    }, "retry settled once the ledger answered");
    expect(settles).toEqual([["app-42", "decided"]]);
  });
});

describe("poll pacing", () => {
  it("paces on the fetched set — a foreign agent's approval must not hot-loop the poll", async () => {
    // The gateway long-polls only when the pending set is EMPTY, so any
    // non-empty answer returns instantly — including sets this presence
    // tracks nothing from (the agent fence skips foreign rows without
    // tracking them). MUTATION-PROOF: key the pacing back on tracked
    // prompts (the old condition) and the loop refetches at network speed —
    // the call count below explodes.
    const controlPlane = createFakeControlPlane();
    gateway.script.push(
      ...Array.from({ length: 10 }, () => ({
        status: 200,
        body: {
          requests: [
            {
              id: "app-donna",
              summary: { action: "Update calendar event", details: [] },
              agent: { id: "ag-donna", name: "Donna" },
            },
          ],
        },
      })),
    );
    const manager = createApprovalsManager({
      controlPlane,
      gatewayUrl: gateway.url,
      approvalsPollSeconds: 1,
      cardUiOf: () => slackApprovalCardUi,
      threadAddressOf: () => unpackThreadAddress,
      credentialOf: botTokenOf,
      // Long pacing: the loop must park after ONE answered poll.
      pacingMs: 60_000,
      onLog: () => {},
    });
    managers.push(manager);
    manager.reconcile([presence()]);

    await waitReal(() => gateway.calls.length >= 1, "first poll answered");
    await settle();
    expect(gateway.calls.length).toBe(1);
    expect(slack.callsTo("chat.postMessage")).toEqual([]);
  });
});

describe("boot recovery", () => {
  it("re-arms unsettled prompts so THIS instance can update cards it never posted", async () => {
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () => [
        {
          approvalId: "app-9",
          agentChannelId: "p1",
          externalThreadId: "D100",
          externalMessageRef: "C9:123.456",
          // A future deadline keeps this test purely about exclude + routing;
          // the real-deadline sweep is exercised in "boot recovery re-arms".
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const manager = makeManager(controlPlane);

    await manager.recoverUnsettled();
    // The recovered approval is still pending on the gateway — served, not
    // excluded; its presence in the response is what keeps the card armed.
    gateway.script.push({ status: 200, body: pendingBody("app-9") });
    manager.reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 1, "loop started");

    // No exclude — the poll serves the full set and the tracked id is simply
    // not re-posted.
    expect(gateway.calls[0]?.exclude).toEqual([]);

    // …and a decision routes the update to the RECORDED message ref.
    await manager.settleDecided("app-9", "⛔ Denied by Ada");
    const updates = slack.callsTo("chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form.channel).toBe("C9");
    expect(updates[0]?.form.ts).toBe("123.456");
  });
});

describe("reconcile", () => {
  it("stops the poll loop for a removed presence", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({ status: 200, body: { requests: [] } });
    const manager = makeManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(() => gateway.calls.length >= 2, "second poll held");

    manager.reconcile([]); // the presence was detached
    gateway.releaseHeld(200, { requests: [] });
    await settle();

    // The released poll ran its course but no third poll followed.
    expect(gateway.calls).toHaveLength(2);
  });
});

describe("claim carries the real gateway deadline", () => {
  it("passes the approval's expiresAt through to the claim when one is present", async () => {
    // The claim persists the deadline so a restart re-arms the card against the
    // REAL gateway timeout, not a guess (see the boot-recovery test below).
    const claims: { expiresAt: string | null }[] = [];
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        claims.push(input);
        return true;
      },
    });
    const future = new Date(Date.now() + 120_000).toISOString();
    gateway.script.push({ status: 200, body: pendingBody("app-e", future) });

    makeManager(controlPlane).reconcile([presence()]);
    await waitReal(() => claims.length === 1, "prompt claimed");

    expect(claims[0]?.expiresAt).toBe(future);
  });
});

describe("stale-links (the running loop reads the LIVE presence view)", () => {
  it("posts NO card while the presence has no link home, then posts once a DM link appears (finding D)", async () => {
    // The approval arrives before the agent's first DM, so the presence has no
    // link yet. The SAME running loop reads the live presenceById map, so when
    // a later reconcile brings a direct link the next poll finds the home and
    // posts. MUTATION-PROOF: revert runLoop/postCard to a snapshot captured at
    // loop start and the card never posts until the process restarts — the
    // second half of this test (the card appearing) then fails.
    const controlPlane = createFakeControlPlane();
    const manager = makeManager(controlPlane);

    // A presence with a service key but NO links (no DM has happened yet).
    manager.reconcile([presence({ links: [] })]);
    await waitReal(() => gateway.calls.length >= 1, "first poll held");
    gateway.releaseHeld(200, pendingBody("app-1"));
    await waitReal(
      () => gateway.calls.length >= 2,
      "loop re-armed after no-home",
    );

    // No home for the card → nothing claimed, nothing posted.
    expect(slack.callsTo("chat.postMessage")).toEqual([]);

    // A later config feed brings the DM link; the SAME loop now has a home.
    manager.reconcile([presence()]);
    gateway.releaseHeld(200, pendingBody("app-1"));
    await waitReal(
      () => slack.callsTo("chat.postMessage").length === 1,
      "card posted once the link exists",
    );
    expect(slack.callsTo("chat.postMessage")[0]?.form.channel).toBe("D100");
  });
});

describe("the card goes to the approver's own DM, never a guest's", () => {
  // The owner let a guest TALK to the agent (a second direct link), but only
  // the owner approves what it does. Before this fix, with two direct links
  // the card followed heap order and landed in the guest's DM, where it
  // expired unanswered while the agent waited.
  const guestFirst = presence({
    links: [
      {
        id: "l-guest",
        conversationId: "cv-guest",
        externalThreadId: "D200",
        kind: "direct",
        externalUserId: null,
        mirrorCursor: null,
      },
      {
        id: "l-owner",
        conversationId: "cv-owner",
        externalThreadId: "D100",
        kind: "direct",
        externalUserId: "U1",
        mirrorCursor: null,
      },
    ],
  });

  it("posts to the link the control plane named, even when a guest DM comes first", async () => {
    const claims: { externalThreadId: string }[] = [];
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        claims.push(input);
        return true;
      },
    });
    gateway.script.push({ status: 200, body: pendingBody("app-own") });

    makeManager(controlPlane).reconcile([
      { ...guestFirst, approvalsLinkId: "l-owner" },
    ]);
    await waitReal(
      () => slack.callsTo("chat.postMessage").length === 1,
      "card posted",
    );

    expect(slack.callsTo("chat.postMessage")[0]?.form.channel).toBe("D100");
    expect(claims.map((c) => c.externalThreadId)).toEqual(["D100"]);
  });

  it("posts NO card when the approver has no DM (null), even though a guest DM exists", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({ status: 200, body: pendingBody("app-none") });

    makeManager(controlPlane).reconcile([
      { ...guestFirst, approvalsLinkId: null },
    ]);
    await waitReal(() => gateway.calls.length >= 2, "loop re-armed");

    expect(slack.callsTo("chat.postMessage")).toEqual([]);
  });

  it("keeps the legacy first-direct pick when an older control plane omits the field", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({ status: 200, body: pendingBody("app-legacy") });

    makeManager(controlPlane).reconcile([guestFirst]);
    await waitReal(
      () => slack.callsTo("chat.postMessage").length === 1,
      "card posted",
    );

    expect(slack.callsTo("chat.postMessage")[0]?.form.channel).toBe("D200");
  });
});

describe("boot recovery re-arms against the ledger's real deadline (finding E)", () => {
  const unsettled = (expiresAt: string | null) => [
    {
      approvalId: "app-r",
      agentChannelId: "p1",
      externalThreadId: "D100",
      externalMessageRef: "C9:1.1",
      expiresAt,
      createdAt: new Date().toISOString(),
    },
  ];

  it("does NOT expire a recovered prompt whose deadline is still in the future", async () => {
    // MUTATION-PROOF: the old re-arm used `Date.now() + 5_000`, so the very
    // first 5s sweep would settle a still-live approval as timed out. With the
    // real (future) deadline threaded through, six sweep cycles touch nothing.
    //
    // Date is faked alongside the timers so advancing the sweep interval also
    // advances the clock settleExpired reads — otherwise the mutation's
    // `now + 5_000` would sit in the real future for the whole (sub-ms) test
    // and never trip, hiding the regression.
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES, "Date"] });
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: async () =>
        unsettled(new Date(Date.now() + 120_000).toISOString()),
    });
    const manager = makeManager(controlPlane);

    await manager.recoverUnsettled();
    manager.reconcile([presence()]); // arms the 5s expiry sweep

    await vi.advanceTimersByTimeAsync(30_000); // six sweeps
    expect(settles).toEqual([]);
  });

  it("DOES expire a recovered prompt whose deadline is already past", async () => {
    // The other side of the same guard: a past ledger deadline settles on the
    // next sweep, so recovery re-arms correctly rather than never expiring.
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES, "Date"] });
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: async () =>
        unsettled(new Date(Date.now() - 1_000).toISOString()),
    });
    const manager = makeManager(controlPlane);

    await manager.recoverUnsettled();
    manager.reconcile([presence()]);

    await vi.advanceTimersByTimeAsync(5_000); // one sweep
    await waitReal(() => settles.length === 1, "past deadline swept");
    expect(settles).toEqual([["app-r", "expired"]]);
  });

  it("keeps an expired card tracked until its credential arrives, then settles it", async () => {
    // Boot order: recovery re-arms the ledger's cards before the config feed
    // has handed this instance the presence's credential. A sweep in that
    // window can neither rewrite the card nor settle the ledger, so the
    // prompt must stay tracked for the sweep that runs once the credential
    // is in. Untracking it here strands a live-looking card for good.
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES, "Date"] });
    const settles: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId, state) => {
        settles.push([approvalId, state]);
      },
      listUnsettledPrompts: async () =>
        unsettled(new Date(Date.now() - 1_000).toISOString()),
    });
    const manager = makeManager(controlPlane);
    await manager.recoverUnsettled();

    // No credential yet: the sweep has nothing it can do.
    manager.reconcile([presence({ credentialsJson: null })]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settles).toEqual([]);

    // The credential arrives; the next sweep settles the card and ledger.
    manager.reconcile([presence()]);
    await vi.advanceTimersByTimeAsync(5_000);
    await waitReal(() => settles.length === 1, "settled once credential in");
    expect(settles).toEqual([["app-r", "expired"]]);
    expect(slack.callsTo("chat.update")).toHaveLength(1);
  });
});

describe("health-report latch (finding H)", () => {
  it("retries the health report while it THROWS, then latches once it succeeds", async () => {
    // The `healthy` flag flips false only AFTER the report resolves. So a
    // report that throws leaves `healthy` true and the NEXT 401 retries it;
    // once a report succeeds the flag latches and further 401s are quiet.
    // MUTATION-PROOF: set `healthy = false` even when the report throws and the
    // second 401 is suppressed — reportApprovalHealth is never called again
    // (reportCalls stalls at 1 and the "poll 2 retried" wait times out).
    vi.useFakeTimers({ toFake: [...TIMER_FAMILIES] });
    let reportShouldThrow = true;
    let reportCalls = 0;
    const reports: [string, boolean][] = [];
    const controlPlane = createFakeControlPlane({
      reportApprovalHealth: async (presenceId, healthy) => {
        reportCalls += 1;
        if (reportShouldThrow) throw new Error("health door down");
        reports.push([presenceId, healthy]);
      },
    });
    gateway.script.push(
      { status: 401, body: {} }, // poll 1 → report throws, healthy STAYS true
      { status: 401, body: {} }, // poll 2 → report RETRIED (still throws)
      { status: 401, body: {} }, // poll 3 → report succeeds, healthy latches false
      { status: 401, body: {} }, // poll 4 → suppressed (already false)
    );

    makeManager(controlPlane).reconcile([presence()]);

    // Poll 1: the report was attempted but threw — nothing recorded.
    await waitReal(() => reportCalls >= 1, "poll 1 report attempted");
    await settle();
    expect(reportCalls).toBe(1);
    expect(reports).toEqual([]);

    // Poll 2: the throw left `healthy` true, so the report is RETRIED.
    await waitReal(() => vi.getTimerCount() >= 2, "parked on backoff 1");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => reportCalls >= 2, "poll 2 report RETRIED");
    await settle();
    expect(reports).toEqual([]); // still throwing, still nothing recorded

    // Poll 3: let the report succeed — healthy flips false, recorded once.
    reportShouldThrow = false;
    await waitReal(() => vi.getTimerCount() >= 2, "parked on backoff 2");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => reports.length === 1, "poll 3 report recorded");
    expect(reports).toEqual([["p1", false]]);
    expect(reportCalls).toBe(3);

    // Poll 4: healthy has latched false → NO further report.
    await waitReal(() => vi.getTimerCount() >= 2, "parked on backoff 3");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitReal(() => gateway.calls.length >= 4, "poll 4 happened");
    await settle();
    expect(reportCalls).toBe(3);
    expect(reports).toEqual([["p1", false]]);
  });
});

// ── Grouped cards ───────────────────────────────────────────────────────────

const contact = (id: string, name: string, extra: object = {}) => ({
  id,
  method: "POST",
  host: "acme.my.salesforce.com",
  path: "/services/data/v60.0/sobjects/Contact",
  app: "salesforce",
  summary: {
    action: "Create Contact",
    details: [
      { label: "Name", value: name },
      { label: "Email", value: `${name.toLowerCase()}@acme.com` },
    ],
  },
  agent: { id: "ag1", name: "Deploy Agent" },
  batch: { id: "t1", label: "Import leads", total: 3 },
  ...extra,
});

describe("grouped approval cards", () => {
  const groupedManager = (controlPlane: ControlPlaneClient) => {
    const manager = createApprovalsManager({
      controlPlane,
      gatewayUrl: gateway.url,
      approvalsPollSeconds: 1,
      cardUiOf: () => slackApprovalCardUi,
      threadAddressOf: () => unpackThreadAddress,
      credentialOf: botTokenOf,
      pacingMs: 25,
      groupDebounceMs: 20,
      onLog: () => {},
    });
    managers.push(manager);
    return manager;
  };

  const lastBlocks = () => {
    const update = slack.callsTo("chat.update").at(-1)!;
    return JSON.stringify(JSON.parse(update.form.blocks!));
  };

  it("posts ONE message for a task's burst, every ledger row sharing its ref", async () => {
    const recorded: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      recordPromptMessage: async (approvalId, ref) => {
        recorded.push([approvalId, ref]);
      },
    });
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          contact("ap-1", "Ada"),
          contact("ap-2", "Grace"),
          contact("ap-3", "Linus"),
        ],
      },
    });
    groupedManager(controlPlane).reconcile([presence()]);
    await waitReal(() => recorded.length === 3, "all three recorded");
    await waitReal(
      () => slack.callsTo("chat.update").length >= 1,
      "grouped render",
    );

    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
    expect(new Set(recorded.map(([, ref]) => ref)).size).toBe(1);
    const blocks = lastBlocks();
    expect(blocks).toContain("3 approvals needed");
    expect(blocks).toContain("Grace");
    expect(blocks).toContain("Import leads");
    // Approve all carries EXACTLY the live ids.
    expect(blocks).toContain('"value":"ap-1,ap-2,ap-3"');
  });

  it("never merges another task, and flags an odd action inside one task", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          contact("ap-1", "Ada"),
          contact("ap-2", "Grace", {
            summary: {
              action: "Delete Contact",
              details: [{ label: "Name", value: "Grace" }],
            },
          }),
          contact("ap-3", "Linus"),
          contact("ap-9", "Other", { batch: { id: "t2" } }),
        ],
      },
    });
    groupedManager(controlPlane).reconcile([presence()]);
    await waitReal(
      () =>
        slack.callsTo("chat.postMessage").length === 2 &&
        slack.callsTo("chat.update").length >= 1,
      "two cards",
    );
    const blocks = lastBlocks();
    expect(blocks).toContain("Not all the same");
    expect(blocks).toContain("1 × Delete Contact");
    expect(blocks).not.toContain("ap-9");
  });

  it("never joins a card that sits outside the approver's current DM", async () => {
    // An older control plane names no home, so the legacy pick puts the card
    // in the first direct link (a guest's DM). Once the feed names the
    // approver's own DM, the task's next request must go THERE, not grow
    // the stranded card where nobody can approve it.
    const claims: string[] = [];
    const recorded: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      claimPrompt: async (input) => {
        claims.push(input.externalThreadId);
        return true;
      },
      recordPromptMessage: async (approvalId, ref) => {
        recorded.push([approvalId, ref]);
      },
    });
    const link = (id: string, thread: string) => ({
      id,
      conversationId: `cv-${id}`,
      externalThreadId: thread,
      kind: "direct" as const,
      externalUserId: null,
      mirrorCursor: null,
    });
    const guestFirst = presence({
      links: [link("l-guest", "D200"), link("l-owner", "D100")],
    });
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada")] },
    });
    const manager = groupedManager(controlPlane);
    manager.reconcile([guestFirst]);
    await waitReal(() => recorded.length === 1, "first card");
    await waitReal(() => gateway.calls.length >= 2, "next poll held");

    manager.reconcile([{ ...guestFirst, approvalsLinkId: "l-owner" }]);
    gateway.releaseHeld(200, {
      requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")],
    });
    await waitReal(() => recorded.length === 2, "second request recorded");

    const posts = slack.callsTo("chat.postMessage");
    expect(posts.map((p) => p.form.channel)).toEqual(["D200", "D100"]);
    expect(claims).toEqual(["D200", "D100"]);
    // The ledger row's message is in the thread its claim names.
    expect(recorded[1]?.[1]).toMatch(/^D100:/);
  });

  it("never joins a recovered card that sits outside the approver's current DM", async () => {
    // After a restart the card is rebuilt from the ledger, which records the
    // thread each row was claimed in. A card left in a guest's DM stays
    // there; the task's next request starts a card in the approver's DM.
    const recorded: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () => [
        {
          approvalId: "ap-1",
          agentChannelId: "p1",
          externalThreadId: "D200",
          externalMessageRef: "D200:500.1",
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          createdAt: new Date().toISOString(),
        },
      ],
      recordPromptMessage: async (approvalId, ref) => {
        recorded.push([approvalId, ref]);
      },
    });
    const manager = groupedManager(controlPlane);
    await manager.recoverUnsettled();
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")] },
    });
    manager.reconcile([presence({ approvalsLinkId: "l1" })]);
    await waitReal(() => recorded.length === 1, "new request recorded");

    expect(recorded[0]?.[0]).toBe("ap-2");
    expect(recorded[0]?.[1]).toMatch(/^D100:/);
    expect(slack.callsTo("chat.postMessage")[0]?.form.channel).toBe("D100");
  });

  it("opens a fresh card once one holds a whole click's worth of rows", async () => {
    // One click can decide at most APPROVAL_GROUP_MAX_IDS ids (the control
    // plane's cap), so a card never holds more live rows than that.
    const recorded: [string, string][] = [];
    const controlPlane = createFakeControlPlane({
      recordPromptMessage: async (approvalId, ref) => {
        recorded.push([approvalId, ref]);
      },
    });
    const burst = Array.from({ length: APPROVAL_GROUP_MAX_IDS + 1 }, (_, i) =>
      contact(`ap-${i}`, `Name${i}`),
    );
    gateway.script.push({ status: 200, body: { requests: burst } });
    groupedManager(controlPlane).reconcile([presence()]);
    await waitReal(() => recorded.length === burst.length, "all recorded");

    expect(slack.callsTo("chat.postMessage")).toHaveLength(2);
    const perRef = new Map<string, number>();
    for (const [, ref] of recorded) perRef.set(ref, (perRef.get(ref) ?? 0) + 1);
    expect([...perRef.values()].sort((a, b) => b - a)).toEqual([
      APPROVAL_GROUP_MAX_IDS,
      1,
    ]);
  });

  it("a grouped click moves decided rows to the done list in one update", async () => {
    const controlPlane = createFakeControlPlane();
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")] },
    });
    const manager = groupedManager(controlPlane);
    manager.reconcile([presence()]);
    await waitReal(
      () => slack.callsTo("chat.update").length >= 1,
      "grouped render",
    );
    const before = slack.callsTo("chat.update").length;

    await manager.settleDecidedMany(["ap-1", "ap-2"], {
      outcome: "approved",
      by: "Ada",
    });

    expect(slack.callsTo("chat.update")).toHaveLength(before + 1);
    const blocks = lastBlocks();
    expect(blocks).toContain("2 approved");
    expect(blocks).not.toContain("channel_group_approve");
    // The finished card keeps the agent's name for the task.
    expect(blocks).toContain("*Import leads* · 2 requests");
  });

  it("settles a group decided on the web in ONE rewrite, ledger after the card", async () => {
    const settles: string[] = [];
    const controlPlane = createFakeControlPlane({
      settlePrompt: async (approvalId) => {
        settles.push(approvalId);
      },
      // Decided on the web: the gateway drops both, but no channel click
      // settled them, so the ledger still holds both pending.
      listUnsettledPrompts: ledgerPending("ap-1", "ap-2"),
    });
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")] },
    });
    gateway.script.push({ status: 200, body: { requests: [] } });
    groupedManager(controlPlane).reconcile([presence()]);
    await waitReal(() => settles.length === 2, "both settled");
    const blocks = lastBlocks();
    expect(blocks).toContain("2 decided");
  });

  it("drops a row an events-arm click already settled from the card's live rows", async () => {
    // An events (HTTP) click decides ap-1 control-plane-side and settles its
    // ledger row; this adapter only sees it leave the pending set. The row
    // must leave the card's live rows too: otherwise the next render still
    // offers it, and Approve all re-sends an id that is already decided.
    let ledger = ["ap-1", "ap-2"];
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () =>
        (await ledgerPending(...ledger)()).filter((p) =>
          ledger.includes(p.approvalId),
        ),
    });
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")] },
    });
    groupedManager(controlPlane).reconcile([presence()]);
    await waitReal(
      () => slack.callsTo("chat.update").length >= 1,
      "grouped render",
    );
    expect(lastBlocks()).toContain('"value":"ap-1,ap-2"');

    ledger = ["ap-2"];
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-2", "Grace")] },
    });
    // A new arrival on the same task forces the card to render again.
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-2", "Grace"), contact("ap-3", "Linus")] },
    });
    await waitReal(
      () => lastBlocks().includes("Linus"),
      "re-render with the new arrival",
    );
    const blocks = lastBlocks();
    expect(blocks).toContain('"value":"ap-2,ap-3"');
    expect(blocks).not.toContain("Ada");
  });

  it("re-renders a grouped card at once when an events-arm click decides one of its rows", async () => {
    // A one-row click on the HTTP arm answers the clicker privately and
    // leaves the shared card to this adapter. Without a re-render here the
    // card keeps showing the decided row until something else changes it.
    let ledger = ["ap-1", "ap-2", "ap-3"];
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () =>
        (await ledgerPending(...ledger)()).filter((p) =>
          ledger.includes(p.approvalId),
        ),
    });
    gateway.script.push({
      status: 200,
      body: {
        requests: [
          contact("ap-1", "Ada"),
          contact("ap-2", "Grace"),
          contact("ap-3", "Linus"),
        ],
      },
    });
    groupedManager(controlPlane).reconcile([presence()]);
    await waitReal(
      () =>
        slack.callsTo("chat.update").length >= 1 &&
        lastBlocks().includes('"value":"ap-1,ap-2,ap-3"'),
      "grouped render",
    );

    ledger = ["ap-2", "ap-3"];
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-2", "Grace"), contact("ap-3", "Linus")] },
    });
    await waitReal(
      () => lastBlocks().includes('"value":"ap-2,ap-3"'),
      "re-render without the decided row",
    );
    const blocks = lastBlocks();
    expect(blocks).toContain("1 decided");
    expect(blocks).not.toContain("Ada");
  });

  it("leaves a grouped card alone when an events-arm click decided all of it", async () => {
    // The control plane replaces a fully decided multi-row card itself
    // ("✅ 2 approved by Ada"); a re-render here would overwrite that.
    let ledger = ["ap-1", "ap-2"];
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () =>
        (await ledgerPending(...ledger)()).filter((p) =>
          ledger.includes(p.approvalId),
        ),
    });
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")] },
    });
    groupedManager(controlPlane).reconcile([presence()]);
    await waitReal(
      () => slack.callsTo("chat.update").length >= 1,
      "grouped render",
    );
    const before = slack.callsTo("chat.update").length;

    ledger = [];
    gateway.script.push({ status: 200, body: { requests: [] } });
    await waitReal(() => gateway.calls.length >= 3, "two more polls");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(slack.callsTo("chat.update")).toHaveLength(before);
  });

  it("renders a recovered grouped card once its rows' details arrive", async () => {
    // After a restart the card is rebuilt from the ledger. A join that was
    // still waiting on its debounced render when the old instance stopped
    // is in the ledger but not on the message: the first poll that fills
    // in every row's details renders the card so it shows up.
    const ref = "D100:500.1";
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () =>
        ["ap-1", "ap-2"].map((approvalId) => ({
          approvalId,
          agentChannelId: "p1",
          externalThreadId: "D100",
          externalMessageRef: ref,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          createdAt: new Date().toISOString(),
        })),
    });
    const manager = groupedManager(controlPlane);
    await manager.recoverUnsettled();
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")] },
    });
    manager.reconcile([presence()]);
    await waitReal(
      () => slack.callsTo("chat.update").length >= 1,
      "recovered card rendered",
    );
    expect(slack.callsTo("chat.postMessage")).toHaveLength(0);
    expect(lastBlocks()).toContain('"value":"ap-1,ap-2"');
  });

  it("renders a recovered grouped card when a row was decided in Slack while the adapter was down", async () => {
    // ap-3 was decided by an events-arm click during the restart: it is no
    // longer pending and the ledger has settled it, so its details never
    // arrive. The card still renders the rows that are left.
    const ref = "D100:500.2";
    const recovered = ["ap-1", "ap-2", "ap-3"].map((approvalId) => ({
      approvalId,
      agentChannelId: "p1",
      externalThreadId: "D100",
      externalMessageRef: ref,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      createdAt: new Date().toISOString(),
    }));
    let ledger = recovered;
    const controlPlane = createFakeControlPlane({
      listUnsettledPrompts: async () => ledger,
    });
    const manager = groupedManager(controlPlane);
    await manager.recoverUnsettled();
    ledger = recovered.filter((p) => p.approvalId !== "ap-3");
    gateway.script.push({
      status: 200,
      body: { requests: [contact("ap-1", "Ada"), contact("ap-2", "Grace")] },
    });
    manager.reconcile([presence()]);
    await waitReal(
      () => slack.callsTo("chat.update").length >= 1,
      "recovered card rendered",
    );
    const blocks = lastBlocks();
    expect(blocks).toContain('"value":"ap-1,ap-2"');
    expect(blocks).toContain("1 decided");
  });
});

describe("grouped Slack card: Approve all covers only what it shows", () => {
  it("carries exactly the listed ids when rows overflow the card", async () => {
    const { groupCardBlocks } = await import("./slack/approval-card");
    const long = "x".repeat(200);
    const live = Array.from({ length: 50 }, (_, i) =>
      contact(`ap-${i}`, `Name${i} ${long}`),
    ) as PendingApproval[];
    const blocks = groupCardBlocks({ live, settled: [] }) as {
      type: string;
      text?: { text: string };
      elements?: {
        action_id?: string;
        value?: string;
        text?: { text: string };
      }[];
    }[];
    const actions = blocks.find((b) => b.type === "actions")!;
    const approve = actions.elements!.find(
      (e) => e.action_id === "channel_group_approve",
    )!;
    const carried = approve.value!.split(",");
    const shownText = JSON.stringify(
      blocks.filter((b) => b.type === "section"),
    );
    // Every carried id's row is on the card; nothing unseen rides along.
    for (const id of carried) {
      const n = id.replace("ap-", "");
      expect(shownText).toContain(`Name${n} `);
    }
    expect(carried.length).toBeLessThan(50);
    expect(approve.text!.text).toBe(`Approve these ${carried.length}`);
    expect(shownText).toContain("Approve all never includes them");
  });
});

describe("grouped Slack card: stays inside Slack's block limits", () => {
  // Slack rejects a whole chat.update with invalid_blocks when any section
  // text passes 3,000 characters, which would freeze the card.
  const SECTION_MAX = 3_000;
  const sectionTexts = (blocks: unknown[]): number[] =>
    (blocks as { type: string; text?: { text: string } }[])
      .filter((b) => b.type === "section")
      .map((b) => b.text!.text.length);

  it("bounds the odd-actions line when many rows each do something different", async () => {
    const { groupCardBlocks } = await import("./slack/approval-card");
    const long = "y".repeat(240); // the gateway's per-value cap
    const live = Array.from({ length: APPROVAL_GROUP_MAX_IDS }, (_, i) =>
      contact(`ap-${i}`, `Name${i}`, {
        summary: { action: `Delete ${long}${i}`, details: [] },
      }),
    ) as PendingApproval[];
    const blocks = groupCardBlocks({ live, settled: [] });
    for (const n of sectionTexts(blocks)) {
      expect(n).toBeLessThanOrEqual(SECTION_MAX);
    }
    expect(JSON.stringify(blocks)).toContain("Not all the same");
  });

  it("bounds the finished card's 'by' list when many people decided rows", async () => {
    const { groupCardBlocks } = await import("./slack/approval-card");
    const settled = Array.from({ length: 200 }, (_, i) => ({
      id: `s-${i}`,
      title: "Create Contact",
      outcome: "approved" as const,
      by: `${"Long Display Name ".repeat(5)}${i}`,
    }));
    const blocks = groupCardBlocks({ live: [], settled });
    for (const n of sectionTexts(blocks)) {
      expect(n).toBeLessThanOrEqual(SECTION_MAX);
    }
    expect(JSON.stringify(blocks)).toContain("200 requests");
  });

  it("fits every Slack limit when every field is at its upstream cap", async () => {
    const { groupCardBlocks } = await import("./slack/approval-card");
    // "&" escapes to "&amp;", so each value is five times longer on the card.
    const amp = (n: number) => "&".repeat(n);
    const link = `https://github.com/${"o".repeat(100)}/${"r".repeat(100)}/issues/${"9".repeat(12)}`;
    const detail = { label: amp(240), value: amp(240), url: link };
    const live = Array.from({ length: APPROVAL_GROUP_MAX_IDS }, (_, i) =>
      contact(`${"a".repeat(60)}${String(i).padStart(4, "0")}`, `N${i}`, {
        host: `${"h".repeat(249)}.com`,
        summary: { action: `${amp(236)}${i}`, details: [detail, detail] },
        agent: { id: "a", name: amp(255) },
        batch: { id: "t", label: amp(120), total: 500 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ) as PendingApproval[];
    const settled = Array.from({ length: 200 }, (_, i) => ({
      id: `s-${i}`,
      title: amp(240),
      outcome: "approved" as const,
      by: `${amp(80)}${i}`,
    }));
    type Text = { text: string };
    type Element = { text: Text | string; value?: string };
    type Block = {
      type: string;
      text?: Text;
      elements?: Element[];
      accessory?: { options: { text: Text; value: string }[] };
    };
    const textOf = (e: Element) =>
      typeof e.text === "string" ? e.text : e.text.text;
    const liveCard = groupCardBlocks({ live, settled }) as Block[];
    const doneCard = groupCardBlocks({ live: [], settled }) as Block[];
    // Not vacuous: the live card has its header, 15 row menus and buttons.
    expect(liveCard.filter((b) => b.accessory)).toHaveLength(15);
    expect(liveCard.map((b) => b.type)).toEqual(
      expect.arrayContaining(["header", "context", "actions"]),
    );
    for (const blocks of [liveCard, doneCard]) {
      expect(blocks.length).toBeLessThanOrEqual(50);
      for (const b of blocks) {
        if (b.type === "header")
          expect(b.text!.text.length).toBeLessThanOrEqual(150);
        if (b.type === "section")
          expect(b.text!.text.length).toBeLessThanOrEqual(SECTION_MAX);
        if (b.type === "context") {
          expect(b.elements!.length).toBeLessThanOrEqual(10);
          for (const e of b.elements!)
            expect(textOf(e).length).toBeLessThanOrEqual(SECTION_MAX);
        }
        for (const o of b.accessory?.options ?? []) {
          expect(o.text.text.length).toBeLessThanOrEqual(75);
          expect(o.value.length).toBeLessThanOrEqual(150);
        }
        if (b.type === "actions") {
          for (const e of b.elements!) {
            expect(textOf(e).length).toBeLessThanOrEqual(75);
            expect(e.value!.length).toBeLessThanOrEqual(2_000);
          }
        }
      }
    }
  });
});

describe("grouped Slack card: counts read right", () => {
  it("says '1 approval needed' and '1 request', never '1 approvals' or '1 requests'", async () => {
    const { groupCardBlocks } = await import("./slack/approval-card");
    const settledRow = {
      id: "s-1",
      title: "Create Contact",
      outcome: "approved" as const,
    };
    const live = groupCardBlocks({
      live: [contact("ap-1", "Ada")] as PendingApproval[],
      settled: [settledRow],
    });
    expect(JSON.stringify(live)).toContain("1 approval needed");
    const done = groupCardBlocks({ live: [], settled: [settledRow] });
    expect(JSON.stringify(done)).toContain("· 1 request\\n");
  });
});
