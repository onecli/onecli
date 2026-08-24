import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The conversation plane's HTTP contract (step 4). The DB laws — the active-turn
 * index, seq allocation, the dispatch arms — live in conversation.pg.test.ts;
 * services are mocked here so this file is about status codes, shapes, auth,
 * and the streaming endpoint's wire format.
 */

const ORG_KEY = "oc_org_test-key";
const RUNNER_TOKEN = "rnr_a-runner";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  createConversation: vi.fn(),
  ensureDirectConversation: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  requireConversation: vi.fn(),
  createTurn: vi.fn(),
  listTurns: vi.fn(),
  abortTurn: vi.fn(),
  readTranscript: vi.fn(),
  sendConversationMessage: vi.fn(),
  createPendingAttachment: vi.fn(),
  getAttachmentForDownload: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findFirst: async () => null,
    },
    runner: {
      findUnique: async ({ where }: { where: { token: string } }) =>
        where.token === RUNNER_TOKEN ? { id: "r-1", name: "laptop" } : null,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
      }),
    },
    workspace: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "p1" ? { id: "p1" } : null,
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/conversation-service", () => ({
  createConversation: services.createConversation,
  ensureDirectConversation: services.ensureDirectConversation,
  listConversations: services.listConversations,
  getConversation: services.getConversation,
  requireConversation: services.requireConversation,
}));

vi.mock("../services/turn-service", () => ({
  createTurn: services.createTurn,
  listTurns: services.listTurns,
  abortTurn: services.abortTurn,
  readTranscript: services.readTranscript,
}));

vi.mock("../services/follow-up-service", () => ({
  sendConversationMessage: services.sendConversationMessage,
}));

vi.mock("../services/attachment-service", () => ({
  createPendingAttachment: services.createPendingAttachment,
  getAttachmentForDownload: services.getAttachmentForDownload,
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");
// Drive events through the SAME bus the stream route resolves (the onprem
// in-process default here) — publish/subscribe moved onto the EventBus
// instance behind the edition provider seam.
const { getEventBus } = await import("../providers/event-bus");
type PublishedEvent = Parameters<
  ReturnType<typeof getEventBus>["publish"]
>[1][number];
const publish = (conversationId: string, events: PublishedEvent[]) =>
  getEventBus().publish(conversationId, events);
const subscriberCount = (conversationId: string) =>
  getEventBus().subscriberCount(conversationId);

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
  "content-type": "application/json",
};

const CONVERSATION = {
  id: "cv-1",
  agentId: "ag-1",
  source: "web",
  externalRef: null,
  direct: false,
  userId: null,
  title: null,
  createdAt: new Date("2026-08-05T00:00:00Z"),
  updatedAt: new Date("2026-08-05T00:00:00Z"),
};

// Per-user since step 6: a direct thread always carries its owner.
const DIRECT_CONVERSATION = {
  ...CONVERSATION,
  id: "cv-direct",
  direct: true,
  userId: "user-1",
};

const TURN = {
  id: "t-1",
  conversationId: "cv-1",
  status: "queued",
  source: "web",
  userId: "user-1",
  message: "hello",
  error: null,
  usage: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-08-05T00:00:00Z"),
};

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  services.createConversation.mockResolvedValue(CONVERSATION);
  services.ensureDirectConversation.mockResolvedValue(DIRECT_CONVERSATION);
  services.listConversations.mockResolvedValue([CONVERSATION]);
  services.getConversation.mockResolvedValue(CONVERSATION);
  services.requireConversation.mockResolvedValue({
    ...CONVERSATION,
    lastSeq: 0,
    harnessSessionRef: null,
  });
  services.createTurn.mockResolvedValue(TURN);
  services.sendConversationMessage.mockResolvedValue({
    kind: "turn",
    turn: TURN,
  });
  services.createPendingAttachment.mockResolvedValue({
    id: "att-1",
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: 3,
    status: "pending",
  });
  services.getAttachmentForDownload.mockResolvedValue({
    meta: {
      id: "att-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      status: "bound",
    },
    bytes: Buffer.from("abc"),
  });
  services.listTurns.mockResolvedValue([TURN]);
  services.abortTurn.mockResolvedValue({ aborted: true, delivered: false });
  services.readTranscript.mockResolvedValue({
    events: [],
    nextSince: 0,
    hasMore: false,
  });
});

describe("authentication", () => {
  const routes: Array<[string, RequestInit]> = [
    ["/v1/conversations", { method: "GET" }],
    ["/v1/conversations", { method: "POST", body: '{"agentId":"ag-1"}' }],
    ["/v1/conversations/cv-1", { method: "GET" }],
    ["/v1/conversations/cv-1/events", { method: "GET" }],
    ["/v1/conversations/cv-1/stream", { method: "GET" }],
    ["/v1/conversations/cv-1/turns", { method: "GET" }],
    [
      "/v1/conversations/cv-1/turns",
      { method: "POST", body: '{"message":"hi"}' },
    ],
    ["/v1/turns/t-1/abort", { method: "POST" }],
    ["/v1/agents/ag-1/conversations/direct", { method: "PUT" }],
  ];

  it.each(routes)("refuses %s without credentials", async (path, init) => {
    const res = await app.request(path, init);
    expect(res.status).toBe(401);
  });

  it("refuses a RUNNER token on the conversation surface", async () => {
    // Token families do not cross: a runner speaks only the runner API.
    const res = await app.request("/v1/conversations/cv-1", {
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "x-workspace-id": "p1",
      },
    });
    expect(res.status).toBe(401);
    expect(services.getConversation).not.toHaveBeenCalled();
  });

  it("refuses an org key that names no workspace", async () => {
    // Strict API-key mode: an `oc_` bearer with no X-Workspace-Id is refused at
    // the middleware, never resolved to some default workspace.
    const res = await app.request("/v1/conversations", {
      headers: { authorization: `Bearer ${ORG_KEY}` },
    });
    expect(res.status).toBe(401);
    expect(services.listConversations).not.toHaveBeenCalled();
  });
});

describe("conversations", () => {
  it("creates one and returns 201", async () => {
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agentId: "ag-1", title: "Deploy help" }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "cv-1", agentId: "ag-1" });
    expect(services.createConversation).toHaveBeenCalledWith("p1", {
      agentId: "ag-1",
      title: "Deploy help",
    });
  });

  it("rejects a body with no agent", async () => {
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: AUTH,
      body: "{}",
    });
    expect(res.status).toBe(422);
    expect(services.createConversation).not.toHaveBeenCalled();
  });

  it("rejects an unknown source rather than silently defaulting", async () => {
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agentId: "ag-1", source: "carrier-pigeon" }),
    });
    expect(res.status).toBe(422);
  });

  it("lists, filtered by agent when asked — as the session's user", async () => {
    const res = await app.request("/v1/conversations?agentId=ag-1", {
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ conversations: [{ id: "cv-1" }] });
    // The viewer is the authenticated user, so the service can fence out
    // other people's direct threads.
    expect(services.listConversations).toHaveBeenCalledWith(
      "p1",
      "user-1",
      "ag-1",
    );
  });

  it("surfaces a service NOT_FOUND as 404, scoped to the workspace", async () => {
    services.getConversation.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Conversation not found"),
    );
    const res = await app.request("/v1/conversations/cv-elsewhere", {
      headers: AUTH,
    });

    expect(res.status).toBe(404);
    expect(services.getConversation).toHaveBeenCalledWith(
      "p1",
      "cv-elsewhere",
      "user-1",
    );
  });

  it("routes the literal sub-paths before the id wildcard", async () => {
    // `/events` and `/stream` must not be read as conversation ids.
    await app.request("/v1/conversations/cv-1/events", { headers: AUTH });
    expect(services.readTranscript).toHaveBeenCalled();
    expect(services.getConversation).not.toHaveBeenCalled();
  });
});

describe("the direct door — PUT /v1/agents/:agentId/conversations/direct", () => {
  it("answers 200 with the thread, workspace-fenced, no body needed", async () => {
    const res = await app.request("/v1/agents/ag-1/conversations/direct", {
      method: "PUT",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("cv-direct");
    expect(body.direct).toBe(true);
    // Per-user since step 6: the door resolves THE CALLER's thread, so the
    // route must pass the authenticated user — never take one from the body.
    expect(services.ensureDirectConversation).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "user-1",
    );
  });

  it("refuses a RUNNER token — token families do not cross", async () => {
    const res = await app.request("/v1/agents/ag-1/conversations/direct", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "x-workspace-id": "p1",
      },
    });

    expect(res.status).toBe(401);
    expect(services.ensureDirectConversation).not.toHaveBeenCalled();
  });

  it("maps the service refusals through the standard table", async () => {
    // The service throws (byo agent → 422, foreign agent → 404); the route
    // adds nothing of its own.
    services.ensureDirectConversation.mockRejectedValueOnce(
      new ServiceError(
        "UNPROCESSABLE",
        "Only hosted agents can hold conversations",
      ),
    );
    const res = await app.request("/v1/agents/ag-1/conversations/direct", {
      method: "PUT",
      headers: AUTH,
    });
    expect(res.status).toBe(422);
  });
});

describe("turns", () => {
  it("posts a message and returns 201, stamping the web origin", async () => {
    const res = await app.request("/v1/conversations/cv-1/turns", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ message: "what changed today?" }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "t-1", status: "queued" });
    // The origin is the ROUTE's to stamp, never the client's: this door is
    // the web (and API-key) surface, so `source: "web"`, and the speaker is
    // the authenticated user — who is also the privacy-fence viewer.
    expect(services.createTurn).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "what changed today?",
      { source: "web", userId: "user-1" },
      undefined,
    );
  });

  it("returns 409 while another turn is in flight", async () => {
    services.createTurn.mockRejectedValue(
      new ServiceError("CONFLICT", "This conversation already has a turn"),
    );
    const res = await app.request("/v1/conversations/cv-1/turns", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ message: "again" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringContaining("already has a turn") },
    });
  });

  it("rejects an empty message", async () => {
    const res = await app.request("/v1/conversations/cv-1/turns", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(422);
    expect(services.createTurn).not.toHaveBeenCalled();
  });

  it("rejects a message past the bound rather than storing it", async () => {
    const res = await app.request("/v1/conversations/cv-1/turns", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ message: "x".repeat(100_001) }),
    });
    expect(res.status).toBe(422);
    expect(services.createTurn).not.toHaveBeenCalled();
  });

  it("rejects a NUL byte with 422, not a 500", async () => {
    // JSON permits U+0000 and PostgreSQL accepts it in neither text nor
    // jsonb, so without an explicit rule the database raises and a plainly
    // bad request becomes a server error.
    const res = await app.request("/v1/conversations/cv-1/turns", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ message: `before${String.fromCharCode(0)}after` }),
    });

    expect(res.status).toBe(422);
    expect(services.createTurn).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await app.request("/v1/conversations/cv-1/turns", {
      method: "POST",
      headers: AUTH,
      body: "not json",
    });
    expect(res.status).toBe(422);
  });

  it("aborts through the sub-resource verb", async () => {
    const res = await app.request("/v1/turns/t-1/abort", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ aborted: true, delivered: false });
    // Fenced like every other write: the viewer travels with the call.
    expect(services.abortTurn).toHaveBeenCalledWith("p1", "t-1", "user-1");
  });

  it("returns 409 for an abort of a finished turn", async () => {
    services.abortTurn.mockRejectedValue(
      new ServiceError("CONFLICT", "This turn has already finished"),
    );
    const res = await app.request("/v1/turns/t-1/abort", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(409);
  });
});

describe("attachments", () => {
  const UPLOAD = (query = "?name=photo.png") =>
    `/v1/conversations/cv-1/attachments${query}`;

  it("uploads raw bytes and returns metadata only (never the bytes)", async () => {
    const res = await app.request(UPLOAD(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${ORG_KEY}`,
        "x-workspace-id": "p1",
        "content-type": "image/png",
      },
      body: Buffer.from("abc"),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "att-1", name: "photo.png" });
    expect(body).not.toHaveProperty("data");
    // Fenced first (workspace + viewer), then stored with the web source.
    expect(services.requireConversation).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
    );
    expect(services.createPendingAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "cv-1",
        userId: "user-1",
        source: "web",
        name: "photo.png",
        mimeType: "image/png",
      }),
    );
  });

  it("requires a ?name= query", async () => {
    const res = await app.request(UPLOAD(""), {
      method: "POST",
      headers: {
        authorization: `Bearer ${ORG_KEY}`,
        "x-workspace-id": "p1",
        "content-type": "image/png",
      },
      body: Buffer.from("abc"),
    });
    expect(res.status).toBe(422);
    expect(services.createPendingAttachment).not.toHaveBeenCalled();
  });

  it("fences the upload — a foreign conversation is a 404, no bytes stored", async () => {
    services.requireConversation.mockRejectedValueOnce(
      new ServiceError("NOT_FOUND", "Conversation not found"),
    );
    const res = await app.request(UPLOAD(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${ORG_KEY}`,
        "x-workspace-id": "p1",
        "content-type": "image/png",
      },
      body: Buffer.from("abc"),
    });
    expect(res.status).toBe(404);
    expect(services.createPendingAttachment).not.toHaveBeenCalled();
  });

  it("downloads with attachment disposition + nosniff, fenced by conversation", async () => {
    const res = await app.request("/v1/conversations/cv-1/attachments/att-1", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("abc");
    expect(services.requireConversation).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
    );
    expect(services.getAttachmentForDownload).toHaveBeenCalledWith(
      "cv-1",
      "att-1",
    );
  });

  it("a download for a foreign conversation is a 404", async () => {
    services.requireConversation.mockRejectedValueOnce(
      new ServiceError("NOT_FOUND", "Conversation not found"),
    );
    const res = await app.request("/v1/conversations/cv-1/attachments/att-1", {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(services.getAttachmentForDownload).not.toHaveBeenCalled();
  });

  it("threads attachmentIds through /messages to the send", async () => {
    const res = await app.request("/v1/conversations/cv-1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        message: "look",
        attachmentIds: [crypto.randomUUID()],
      }),
    });
    expect(res.status).toBe(201);
    expect(services.sendConversationMessage).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "look",
      { source: "web", userId: "user-1" },
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it("allows an EMPTY message when attachments are present", async () => {
    const res = await app.request("/v1/conversations/cv-1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        message: "",
        attachmentIds: [crypto.randomUUID()],
      }),
    });
    expect(res.status).toBe(201);
    expect(services.sendConversationMessage).toHaveBeenCalled();
  });

  it("still rejects an empty message with no attachments", async () => {
    const res = await app.request("/v1/conversations/cv-1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(422);
    expect(services.sendConversationMessage).not.toHaveBeenCalled();
  });
});

describe("the transcript", () => {
  it("passes the cursor and limit through", async () => {
    await app.request("/v1/conversations/cv-1/events?since=12&limit=50", {
      headers: AUTH,
    });
    expect(services.readTranscript).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
      {
        since: 12,
        limit: 50,
      },
    );
  });

  it("rejects a limit past the cap instead of quietly clamping", async () => {
    const res = await app.request("/v1/conversations/cv-1/events?limit=9999", {
      headers: AUTH,
    });
    expect(res.status).toBe(422);
  });

  it("rejects a non-numeric cursor", async () => {
    const res = await app.request("/v1/conversations/cv-1/events?since=abc", {
      headers: AUTH,
    });
    expect(res.status).toBe(422);
  });
});

/**
 * The SSE endpoint. `app.request()` returns a real `Response` whose body is a
 * readable stream, so these read actual bytes off the wire rather than
 * inspecting the handler.
 */
describe("the live stream", () => {
  /** Read frames until `stop` says enough, then cancel like a closed tab. */
  const readStream = async (
    res: Response,
    stop: (text: string) => boolean,
    onFirstRead?: () => void | Promise<void>,
  ): Promise<string> => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let signalled = false;
    try {
      for (let i = 0; i < 50; i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (!signalled && onFirstRead) {
          signalled = true;
          await onFirstRead();
        }
        if (stop(text)) break;
      }
    } finally {
      await reader.cancel();
    }
    return text;
  };

  it("tells nginx not to buffer it", async () => {
    // Nginx buffers proxied responses by default and Cache-Control does not
    // change that. Without this header every self-hosted install behind nginx
    // gets a stream that still "works" and is no longer live.
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body?.cancel();
  });

  it("CUTS a reader that stops consuming entirely", async () => {
    // The buffer cap alone cannot end the connection: the loop only notices
    // the flag when it comes back round, and a reader that never pulls again
    // leaves it parked inside the write. The write deadline is what reaches
    // that case — the suspended laptop the cap is written for.
    vi.useFakeTimers();
    try {
      const res = await app.request("/v1/conversations/cv-1/stream", {
        headers: AUTH,
      });
      const reader = res.body!.getReader();
      await reader.read(); // subscribe, then stop consuming

      publish(
        "cv-1",
        Array.from({ length: 5 }, (_, i) => ({
          seq: i + 1,
          turnId: "t-1",
          type: "error" as const,
          event: { type: "error" as const, message: "x" },
        })),
      );
      await vi.advanceTimersByTimeAsync(31_000);

      // The server let go: the subscription is gone without the client ever
      // cancelling.
      expect(subscriberCount("cv-1")).toBe(0);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("declares itself as an event stream", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Proxies and Nginx both need telling not to buffer this.
    expect(res.headers.get("cache-control")).toContain("no-cache");
    await res.body?.cancel();
  });

  it("AUTHORIZES before opening the stream — a refusal is a status code", async () => {
    // Opening a 200 and then closing it would leave a client unable to tell
    // "not allowed" from "nothing happened".
    services.requireConversation.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Conversation not found"),
    );
    const res = await app.request("/v1/conversations/cv-nope/stream", {
      headers: AUTH,
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  });

  it("replays history FIRST, each frame carrying its seq as the SSE id", async () => {
    services.readTranscript.mockResolvedValue({
      events: [
        { seq: 1, turnId: "t-1", type: "turn.started", payload: {} },
        {
          seq: 2,
          turnId: "t-1",
          type: "tool.started",
          payload: { name: "bash" },
        },
      ],
      nextSince: 2,
      hasMore: false,
    });

    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const text = await readStream(res, (t) => t.includes('"seq":2'));

    expect(text).toContain("id: 1");
    expect(text).toContain("id: 2");
    expect(text).toContain("event: transcript");
    expect(text.indexOf("id: 1")).toBeLessThan(text.indexOf("id: 2"));
  });

  it("honours ?since= so a reconnect does not replay what was seen", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream?since=7", {
      headers: AUTH,
    });
    await readStream(res, () => true);

    expect(services.readTranscript).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
      {
        since: 7,
        limit: 500,
      },
    );
  });

  it("honours Last-Event-ID, which is what a reconnecting client sends", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: { ...AUTH, "last-event-id": "42" },
    });
    await readStream(res, () => true);

    expect(services.readTranscript).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
      {
        since: 42,
        limit: 500,
      },
    );
  });

  it("prefers an explicit ?since= over the header", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream?since=9", {
      headers: { ...AUTH, "last-event-id": "42" },
    });
    await readStream(res, () => true);

    expect(services.readTranscript).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
      {
        since: 9,
        limit: 500,
      },
    );
  });

  it("emits a heartbeat, which is what keeps every proxy hop from calling it idle", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const text = await readStream(res, (t) => t.includes(": keep-alive"));

    // A COMMENT, not an event: bytes on the wire without waking the client.
    expect(text).toContain(": keep-alive");
    expect(text).not.toContain("event: heartbeat");
  });

  it("TAILS a published event to a connected reader", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    // Publish once the handler has subscribed (i.e. after its first write).
    const text = await readStream(
      res,
      (t) => t.includes("tool.finished"),
      () => {
        publish("cv-1", [
          {
            seq: 5,
            turnId: "t-1",
            type: "tool.finished",
            event: {
              type: "tool.finished",
              callId: "c1",
              name: "bash",
              output: "ok",
            },
          },
        ]);
      },
    );

    expect(text).toContain("id: 5");
    expect(text).toContain("tool.finished");
  });

  it("does not deliver ANOTHER conversation's events", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const text = await readStream(
      res,
      (t) => t.includes(": keep-alive"),
      () => {
        publish("cv-OTHER", [
          {
            seq: 99,
            turnId: "t-x",
            type: "error",
            event: { type: "error", message: "LEAKED" },
          },
        ]);
      },
    );

    expect(text).not.toContain("LEAKED");
  });

  it("drops events at or below what the reader already has", async () => {
    services.readTranscript.mockResolvedValue({
      events: [{ seq: 4, turnId: "t-1", type: "turn.started", payload: {} }],
      nextSince: 4,
      hasMore: false,
    });

    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const text = await readStream(
      res,
      (t) => t.includes("FRESH"),
      () => {
        publish("cv-1", [
          // Already in the replayed history — a duplicate, not news.
          {
            seq: 4,
            turnId: "t-1",
            type: "error",
            event: { type: "error", message: "STALE" },
          },
          {
            seq: 5,
            turnId: "t-1",
            type: "error",
            event: { type: "error", message: "FRESH" },
          },
        ]);
      },
    );

    expect(text).not.toContain("STALE");
    expect(text).toContain("FRESH");
    // Contiguous tail (4 replayed, 5 next): no gap, so no repair read — the
    // ordinary delta stream must never pay extra history queries.
    expect(services.readTranscript).toHaveBeenCalledTimes(1);
  });

  it("REPAIRS a hole in the live tail from history — a dropped publish must not hide durable events", async () => {
    // The Redis bus may drop or reorder a publish (a blip, cross-pod
    // interleaving). Without the repair, `lastSeq` jumps the hole and the
    // dedupe hides the missing durable events for the life of the
    // connection — the client never reconnects because keep-alives flow.
    services.readTranscript
      // The startup snapshot: durable history ends at seq 4.
      .mockResolvedValueOnce({
        events: [{ seq: 4, turnId: "t-1", type: "turn.started", payload: {} }],
        nextSince: 4,
        hasMore: false,
      })
      // The repair read: seq 6 was durable and its publish was dropped
      // (5, 7, 8 were deltas — published but never stored, so a partial
      // read-back is the normal shape).
      .mockResolvedValueOnce({
        events: [
          {
            seq: 6,
            turnId: "t-1",
            type: "tool.finished",
            payload: { name: "bash", output: "RECOVERED" },
          },
        ],
        nextSince: 6,
        hasMore: false,
      })
      .mockResolvedValue({ events: [], nextSince: 9, hasMore: false });

    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const text = await readStream(
      res,
      (t) => t.includes("id: 9"),
      () => {
        // Seq 9 arrives with 5–8 missing from this connection's tail.
        publish("cv-1", [
          {
            seq: 9,
            turnId: "t-1",
            type: "error",
            event: { type: "error", message: "AFTER-GAP" },
          },
        ]);
      },
    );

    // The lost durable event came back from history, before the live event.
    expect(text).toContain("RECOVERED");
    expect(text.indexOf("id: 6")).toBeLessThan(text.indexOf("id: 9"));
    expect(text).toContain("AFTER-GAP");
    // The repair asked for exactly what this connection was missing.
    expect(services.readTranscript).toHaveBeenNthCalledWith(
      2,
      "p1",
      "cv-1",
      "user-1",
      { since: 4, limit: 500 },
    );
  });

  it("replays a backlog LARGER than one page, to exhaustion", async () => {
    // One page and then tailing would advance the cursor past the rest of the
    // backlog, and since `lastSeq` only moves forward the live tail could
    // never fill it in — a silent hole in the exact property this endpoint
    // sells. A long turn with many tool calls clears 500 events easily.
    // Small pages so the test exercises the LOOP rather than the frame count;
    // `hasMore` is what drives it, and the mock decides that, not the size.
    const page = (start: number, count: number, hasMore: boolean) => ({
      events: Array.from({ length: count }, (_, i) => ({
        seq: start + i,
        turnId: "t-1",
        type: "tool.started",
        payload: { name: "bash" },
      })),
      nextSince: start + count - 1,
      hasMore,
    });
    services.readTranscript
      .mockResolvedValueOnce(page(1, 3, true))
      .mockResolvedValueOnce(page(4, 3, true))
      .mockResolvedValueOnce(page(7, 2, false));

    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const text = await readStream(res, (t) => t.includes("id: 8"));

    expect(services.readTranscript).toHaveBeenCalledTimes(3);
    // The first page, a middle page, and the last event all arrived.
    for (const seq of [1, 4, 7, 8]) {
      expect(text).toContain(`id: ${seq}`);
    }
    // Each page asked for what came after the previous one.
    expect(services.readTranscript).toHaveBeenNthCalledWith(
      2,
      "p1",
      "cv-1",
      "user-1",
      {
        since: 3,
        limit: 500,
      },
    );
    expect(services.readTranscript).toHaveBeenNthCalledWith(
      3,
      "p1",
      "cv-1",
      "user-1",
      {
        since: 6,
        limit: 500,
      },
    );
  });

  it("loses NOTHING published while the history is being read", async () => {
    // The subscribe-then-snapshot order matters: subscribing afterwards would
    // drop this event, and since `lastSeq` only advances it would never be
    // sent on this connection at all — a hole only a reconnect could heal.
    services.readTranscript.mockImplementation(async () => {
      publish("cv-1", [
        {
          seq: 3,
          turnId: "t-1",
          type: "error",
          event: { type: "error", message: "MID-READ" },
        },
      ]);
      return {
        events: [{ seq: 2, turnId: "t-1", type: "turn.started", payload: {} }],
        nextSince: 2,
        hasMore: false,
      };
    });

    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const text = await readStream(res, (t) => t.includes("MID-READ"));

    expect(text).toContain("MID-READ");
    expect(text).toContain("id: 3");
    // And still in order, after the history it follows.
    expect(text.indexOf("id: 2")).toBeLessThan(text.indexOf("id: 3"));
  });

  it("RELEASES its subscription when the reader goes away", async () => {
    // A closed tab that left a listener behind would leak one per reconnect,
    // and the ALB closes these connections hourly no matter what.
    const before = subscriberCount("cv-1");
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    await readStream(res, (t) => t.includes(": keep-alive"));

    // Give the abort a tick to propagate through the stream helper.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscriberCount("cv-1")).toBe(before);
  });
});

describe("the cursor validates the same way from either direction", () => {
  it("ignores a junk Last-Event-ID rather than coercing it to NaN", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: { ...AUTH, "last-event-id": "not-a-number" },
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(services.readTranscript).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
      {
        since: undefined,
        limit: 500,
      },
    );
  });

  it("ignores a negative Last-Event-ID", async () => {
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: { ...AUTH, "last-event-id": "-5" },
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(services.readTranscript).toHaveBeenCalledWith(
      "p1",
      "cv-1",
      "user-1",
      {
        since: undefined,
        limit: 500,
      },
    );
  });
});

describe("a reader that falls behind", () => {
  it("is CUT BY THE SERVER rather than buffered without limit", async () => {
    // A reader that stops consuming (suspended laptop, wedged proxy) blocks
    // the write loop while the subscriber keeps appending behind it. Closing
    // is the right answer and not a lossy one: history is authoritative, so
    // the client reconnects from its last seq and gets the gap back.
    //
    // The assertion has to be that the SERVER closes it. An earlier version
    // checked the subscriber count after `reader.cancel()` — which the abort
    // path zeroes regardless, so it passed with the overflow cut deleted
    // entirely. It proved nothing.
    const res = await app.request("/v1/conversations/cv-1/stream", {
      headers: AUTH,
    });
    const reader = res.body!.getReader();
    await reader.read(); // let the handler subscribe and park

    // Far more than the buffer allows, published while nothing is draining.
    const flood = (batch: number) =>
      publish(
        "cv-1",
        Array.from({ length: 600 }, (_, i) => ({
          seq: batch * 600 + i + 1,
          turnId: "t-1",
          type: "error" as const,
          event: { type: "error" as const, message: "x" },
        })),
      );
    for (let batch = 0; batch < 3; batch += 1) flood(batch);

    // Now drain. The stream must END on its own — no cancel from this side.
    let closed = false;
    let frames = 0;
    const decoder = new TextDecoder();
    for (let i = 0; i < 400; i += 1) {
      const { value, done } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
      frames += (decoder.decode(value, { stream: true }).match(/^id: /gm) ?? [])
        .length;
    }

    expect(closed).toBe(true);
    // And it did not first deliver the whole 1,800-event flood.
    expect(frames).toBeLessThan(1_800);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscriberCount("cv-1")).toBe(0);
  });
});
