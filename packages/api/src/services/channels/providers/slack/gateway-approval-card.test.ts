import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settleSlackGatewayApprovalCard } from "./gateway-approval-card";

/**
 * The Slack rewrite of a settled gateway card, over the wire against a
 * Slack-shaped server (`SLACK_API_BASE_URL`, the house seam): exactly one
 * `chat.update` on the ref's channel/ts, the bot token as the credential,
 * one escaped line in the adapter's own shape (`title · outcome`), the CSV
 * detached. A malformed ref or a credential with no bot token sends
 * nothing.
 */

let server: Server;
let calls: { path: string; form: URLSearchParams; auth: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      calls.push({
        path: req.url ?? "",
        form: new URLSearchParams(raw),
        auth: req.headers.authorization ?? "",
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, channel: "D1", ts: "1700.1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  process.env.SLACK_API_BASE_URL = `http://127.0.0.1:${String(port)}`;
});
afterAll(async () => {
  delete process.env.SLACK_API_BASE_URL;
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  calls = [];
});

const CREDS = JSON.stringify({ botToken: "xoxb-test" });

describe("settleSlackGatewayApprovalCard", () => {
  it("rewrites the card in place as one escaped line and detaches its CSV", async () => {
    await settleSlackGatewayApprovalCard({
      credentialsJson: CREDS,
      externalMessageRef: "D1:1700.1",
      title: "Create <3> Accounts\nnow",
      text: "Replaced by your message · <not sent>",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.path).toBe("/chat.update");
    const tokenSent =
      call!.form.get("token") ?? call!.auth.replace("Bearer ", "");
    expect(tokenSent).toBe("xoxb-test");
    expect(call!.form.get("channel")).toBe("D1");
    expect(call!.form.get("ts")).toBe("1700.1");
    expect(call!.form.get("file_ids")).toBe("[]");
    const text = call!.form.get("text") ?? "";
    // The title on one line, then the outcome; platform copy and the
    // agent-written title both escaped: no raw angle brackets reach mrkdwn.
    expect(text).toBe(
      "Create &lt;3&gt; Accounts now · Replaced by your message · &lt;not sent&gt;",
    );
    expect(JSON.parse(call!.form.get("blocks") ?? "[]")).toEqual([
      { type: "section", text: { type: "mrkdwn", text } },
    ]);
  });

  it("a grouped card (no single title) reads the outcome alone", async () => {
    await settleSlackGatewayApprovalCard({
      credentialsJson: CREDS,
      externalMessageRef: "D1:1700.1",
      title: undefined,
      text: "Replaced by your message",
    });
    expect(calls[0]!.form.get("text")).toBe("Replaced by your message");
  });

  it.each([
    ["a malformed ref", CREDS, "no-separator"],
    ["a credential without a bot token", JSON.stringify({}), "D1:1700.1"],
  ])("sends nothing for %s", async (_, credentialsJson, ref) => {
    await settleSlackGatewayApprovalCard({
      credentialsJson,
      externalMessageRef: ref,
      title: "Create Contact",
      text: "Replaced by your message",
    });
    expect(calls).toHaveLength(0);
  });
});
