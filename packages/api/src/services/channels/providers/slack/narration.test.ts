import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { slackProvider } from "./provider";

/**
 * SLACK NARRATION — the task card that says what the agent is doing while it
 * works ("Running a command"), posted beside the conversation.
 *
 * The mechanism is a plain message carrying a `plan` block, advanced with
 * `chat.update` and removed with `chat.delete`. Slack's streaming methods
 * render the same block but demand a thread root, which in a DM means a
 * thread per turn — the cost this shape exists to avoid (verified live
 * 2026-08-31: a `plan` block posted with `chat.postMessage` and no
 * `thread_ts` renders top-level in a DM).
 *
 * Only `fetch` is mocked: the real provider and the real block building run,
 * because the block shape IS the contract.
 */

const CREDS = JSON.stringify({ botToken: "xoxb-test-token" });

interface SlackRequest {
  method: string;
  form: URLSearchParams;
}

let requests: SlackRequest[] = [];
let responder: (method: string) => Record<string, unknown>;

const requestAt = (index: number): SlackRequest => {
  const request = requests[index];
  if (!request) throw new Error(`expected a request at index ${index}`);
  return request;
};

const planOf = (request: SlackRequest) => {
  const blocks = JSON.parse(request.form.get("blocks") ?? "[]") as {
    type: string;
    title: string;
    tasks: { task_id: string; title: string; status: string }[];
  }[];
  const plan = blocks[0];
  if (!plan) throw new Error("expected a plan block");
  return plan;
};

beforeEach(() => {
  requests = [];
  // `chat.postMessage` answers with the channel too, and the client
  // validates it — a fixture that omits it fails the parse, not the code.
  responder = () => ({ ok: true, channel: "D123", ts: "1788200000.000100" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      const method = String(url).split("/api/")[1] ?? "";
      requests.push({
        method,
        form: new URLSearchParams(init.body ?? ""),
      });
      return {
        ok: true,
        status: 200,
        json: async () => responder(method),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("posting the card", () => {
  it("posts TOP-LEVEL when the conversation has no thread", async () => {
    const result = await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["Running a command"],
      cardTs: null,
    });

    expect(result).toEqual({ cardTs: "1788200000.000100" });
    expect(requests.map((r) => r.method)).toEqual(["chat.postMessage"]);
    // The whole reason this is a message rather than a stream: Slack's
    // streaming methods answer `invalid_thread_ts` without a root, so they
    // cannot put a card in a DM without opening a thread for it.
    expect(requestAt(0).form.get("thread_ts")).toBeNull();
  });

  it("posts IN THREAD when the conversation is threaded", async () => {
    await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "C123",
      threadTs: "1788199999.000001",
      activities: ["Running a command"],
      cardTs: null,
    });

    expect(requestAt(0).form.get("thread_ts")).toBe("1788199999.000001");
  });

  it("renders every step but the newest as finished", async () => {
    await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["Running a command", "Reading a file", "Editing a file"],
      cardTs: null,
    });

    // The agent moved on from the earlier steps, so they are done by
    // definition — only the newest is still running.
    expect(planOf(requestAt(0)).tasks).toEqual([
      { task_id: "t0", title: "Running a command", status: "complete" },
      { task_id: "t1", title: "Reading a file", status: "complete" },
      { task_id: "t2", title: "Editing a file", status: "in_progress" },
    ]);
  });

  it("names the plan, so it is not titled by Slack's default", async () => {
    await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["Running a command"],
      cardTs: null,
    });

    expect(planOf(requestAt(0)).title).toBe("Working on your request");
  });
});

describe("advancing the card", () => {
  it("UPDATES the existing card rather than posting a second one", async () => {
    const result = await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["Running a command", "Reading a file"],
      cardTs: "1788200000.000100",
    });

    expect(result).toEqual({ cardTs: "1788200000.000100" });
    expect(requests.map((r) => r.method)).toEqual(["chat.update"]);
    expect(requestAt(0).form.get("ts")).toBe("1788200000.000100");
  });

  it("re-renders the WHOLE list, so there is no partial state to reconcile", async () => {
    await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["Running a command", "Reading a file"],
      cardTs: "1788200000.000100",
    });

    expect(planOf(requestAt(0)).tasks).toHaveLength(2);
  });
});

describe("when Slack will not narrate", () => {
  it("answers null on refusal and never throws — the loader stands", async () => {
    responder = () => ({ ok: false, error: "channel_type_not_supported" });

    const result = await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["Running a command"],
      cardTs: null,
    });

    // Null, not a throw: narration decorates a loader that is already
    // standing, so a workspace without it loses the words and nothing else.
    expect(result).toBeNull();
  });

  it("answers null without calling Slack when there is no credential", async () => {
    const result = await slackProvider.narrateThreadWork!({
      credentialsJson: null,
      channel: "D123",
      threadTs: null,
      activities: ["Running a command"],
      cardTs: null,
    });

    expect(result).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe("removing the card", () => {
  it("deletes the message, so a loader never lingers as a reply", async () => {
    await slackProvider.removeThreadNarration!({
      credentialsJson: CREDS,
      channel: "D123",
      cardTs: "1788200000.000100",
    });

    expect(requests.map((r) => r.method)).toEqual(["chat.delete"]);
    expect(requestAt(0).form.get("ts")).toBe("1788200000.000100");
  });

  it("swallows an already-gone card — the clear and the sweep may both run", async () => {
    responder = () => ({ ok: false, error: "message_not_found" });

    await expect(
      slackProvider.removeThreadNarration!({
        credentialsJson: CREDS,
        channel: "D123",
        cardTs: "1788200000.000100",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("untrusted text", () => {
  it("bounds a hostile step to Slack's task-title limit", async () => {
    await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["x".repeat(5_000)],
      cardTs: null,
    });

    // The shared derivation already bounds this to one short line; the
    // provider re-bounds because an over-long title fails the whole call,
    // taking the narration down with it.
    expect(planOf(requestAt(0)).tasks[0]!.title.length).toBeLessThanOrEqual(
      256,
    );
  });

  it("sends the step as a JSON field, never as markup", async () => {
    await slackProvider.narrateThreadWork!({
      credentialsJson: CREDS,
      channel: "D123",
      threadTs: null,
      activities: ["<script>alert(1)</script>"],
      cardTs: null,
    });

    // Verbatim in a typed field — Slack renders a task title as plain text,
    // so there is no markup surface to escape into.
    expect(planOf(requestAt(0)).tasks[0]!.title).toBe(
      "<script>alert(1)</script>",
    );
  });
});
