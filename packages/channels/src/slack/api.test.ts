import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  oauthUserAccess,
  SlackApiError,
  usersInfo,
  conversationsInfo,
} from "./api";

/**
 * The bounded HTTP retry inside `slackCall`: 429/5xx are retried up to 3
 * attempts (Retry-After honored when present, growing backoff when absent —
 * a missing header must NOT read as "wait 0ms", or a rate-limited call gets
 * re-hammered immediately, exactly what Slack's review fails apps for);
 * `ok:false` refusals are deterministic and never retried.
 */

let server: Server;
let scripted: {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  delayMs?: number;
}[] = [];
let hits: number[] = [];

const OK_BODY = { ok: true, user: { id: "U1", profile: {} } };

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        hits.push(Date.now());
        const next = scripted.shift() ?? { status: 200, body: OK_BODY };
        res.writeHead(next.status, {
          "content-type": "application/json",
          ...(next.headers ?? {}),
        });
        setTimeout(() => res.end(JSON.stringify(next.body)), next.delayMs ?? 0);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  process.env.SLACK_API_BASE_URL = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  delete process.env.SLACK_API_BASE_URL;
});

afterEach(() => {
  scripted = [];
  hits = [];
});

describe("slackCall's bounded retry", () => {
  it("HTTP 429 Retry-After 30 returns its cooldown without an early retry", async () => {
    scripted = [{ status: 429, headers: { "retry-after": "30" }, body: {} }];
    await expect(
      conversationsInfo("xoxb-fictional", "C_ROOM"),
    ).rejects.toMatchObject({
      name: "SlackApiError",
      code: "ratelimited",
      retryAfterMs: 30_000,
    });
    expect(hits).toHaveLength(1);
  });

  it("parent abort cancels a Retry-After sleep and never retries", async () => {
    scripted = [{ status: 429, headers: { "retry-after": "1" }, body: {} }];
    const controller = new AbortController();
    const request = conversationsInfo("xoxb-fictional", "C_ROOM", {
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(hits).toHaveLength(1);
  });

  it("parent abort cancels an in-flight request without retry", async () => {
    scripted = [{ status: 200, body: {}, delayMs: 500 }];
    const controller = new AbortController();
    const request = conversationsInfo("xoxb-fictional", "C_ROOM", {
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await rejected;
    expect(hits).toHaveLength(1);
  });

  it("the per-request 15 second timeout still applies with a parent signal", async () => {
    scripted = [{ status: 200, body: {}, delayMs: 15_200 }];
    await expect(
      conversationsInfo("xoxb-fictional", "C_ROOM", {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(hits).toHaveLength(1);
  }, 20_000);

  it("an already aborted parent never sends a request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      conversationsInfo("xoxb-fictional", "C_ROOM", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toHaveLength(0);
  });
  it("retries a 429 and honors Retry-After", async () => {
    scripted = [
      { status: 429, headers: { "retry-after": "0" }, body: {} },
      { status: 200, body: OK_BODY },
    ];
    const result = await usersInfo("xoxb-test", "U1");
    expect(result.user.id).toBe("U1");
    expect(hits).toHaveLength(2);
  });

  it("a 5xx WITHOUT Retry-After backs off — never an immediate re-hammer", async () => {
    scripted = [
      { status: 502, body: {} },
      { status: 200, body: OK_BODY },
    ];
    await usersInfo("xoxb-test", "U1");
    expect(hits).toHaveLength(2);
    // The backoff branch (500ms * attempt) must actually run: Number(null)
    // is 0, which once made a missing header mean "retry NOW".
    expect(hits[1]! - hits[0]!).toBeGreaterThanOrEqual(400);
  });

  it("gives up after 3 attempts and surfaces the HTTP status", async () => {
    scripted = [
      { status: 429, headers: { "retry-after": "0" }, body: {} },
      { status: 429, headers: { "retry-after": "0" }, body: {} },
      { status: 429, headers: { "retry-after": "0" }, body: {} },
    ];
    await expect(usersInfo("xoxb-test", "U1")).rejects.toMatchObject({
      name: "SlackApiError",
      code: "ratelimited",
      retryAfterMs: 0,
    });
    expect(hits).toHaveLength(3);
  });

  it("NEVER retries an ok:false refusal — deterministic answers stay single-shot", async () => {
    scripted = [{ status: 200, body: { ok: false, error: "user_not_found" } }];
    await expect(usersInfo("xoxb-test", "U1")).rejects.toThrow(SlackApiError);
    expect(hits).toHaveLength(1);
  });
});

describe("oauthUserAccess (Connect your Slack)", () => {
  it("accepts a USER-scope-only response: no top-level bot token, the person's token in authed_user", async () => {
    // The live shape that broke the first real connect: a user_scope-only
    // authorize returns no access_token / bot_user_id at the top level.
    scripted = [
      {
        status: 200,
        body: {
          ok: true,
          app_id: "A1",
          team: { id: "T1", name: "Acme" },
          authed_user: {
            id: "U1",
            scope: "channels:history,im:history",
            access_token: "xoxp-1",
            token_type: "user",
          },
        },
      },
    ];
    const r = await oauthUserAccess({
      clientId: "c",
      clientSecret: "s",
      code: "x",
      redirectUri: "https://r",
    });
    expect(r.team.id).toBe("T1");
    expect(r.authed_user).toMatchObject({ id: "U1", access_token: "xoxp-1" });
  });

  it("refuses a response with no person token", async () => {
    scripted = [
      {
        status: 200,
        body: { ok: true, team: { id: "T1" }, authed_user: { id: "U1" } },
      },
    ];
    await expect(
      oauthUserAccess({
        clientId: "c",
        clientSecret: "s",
        code: "x",
        redirectUri: "r",
      }),
    ).rejects.toThrow();
  });
});
