import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SlackApiError, usersInfo } from "./slack-api";

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
        res.end(JSON.stringify(next.body));
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
    await expect(usersInfo("xoxb-test", "U1")).rejects.toThrow("HTTP 429");
    expect(hits).toHaveLength(3);
  });

  it("NEVER retries an ok:false refusal — deterministic answers stay single-shot", async () => {
    scripted = [{ status: 200, body: { ok: false, error: "user_not_found" } }];
    await expect(usersInfo("xoxb-test", "U1")).rejects.toThrow(SlackApiError);
    expect(hits).toHaveLength(1);
  });
});
