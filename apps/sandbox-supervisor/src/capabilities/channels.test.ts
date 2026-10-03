import { describe, expect, it } from "vitest";
import type { AgentChannelPresenceWire } from "@onecli/agent-protocol";
import { channelsFragment, channelsTools } from "./channels";

const live: AgentChannelPresenceWire = {
  provider: "slack",
  status: "active",
  handle: "donna",
  workspaceName: "Acme",
};
const attention: AgentChannelPresenceWire = {
  ...live,
  status: "needs_attention",
};
const removed: AgentChannelPresenceWire = { ...live, status: "disabled" };

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("channelsFragment", () => {
  it("renders NOTHING for an agent with no presence — silence, not an empty heading", () => {
    expect(channelsFragment([])).toBeNull();
  });

  it("a live presence: names the platform, the handle and the workspace as standing truth", () => {
    const fragment = channelsFragment([live]);
    expect(fragment?.id).toBe("channels");
    expect(fragment?.title).toBe("Where you talk");
    const body = flat(fragment!.body);
    expect(body).toContain(
      "You are reachable on Slack as @donna in the Acme workspace, through your own Slack app",
    );
  });

  it("a live presence: states the gateway rule for chat — the live incident this section exists to end", () => {
    // The agent used to reach for slack.com through the proxy and then ask
    // the person to connect Slack while answering them IN Slack.
    const body = flat(channelsFragment([live])!.body);
    expect(body).toContain("Slack is NOT a gateway connection");
    expect(body).toContain("never ask anyone to connect Slack");
    expect(body).toContain("never say you lack Slack access");
    expect(body).toContain("You already live there");
  });

  it("a live presence: teaches how to tell a Slack turn from a web one, and how replies route", () => {
    const body = flat(channelsFragment([live])!.body);
    expect(body).toContain("from the OneCLI dashboard or from Slack");
    expect(body).toContain('"This is a direct conversation with…" note');
    expect(body).toContain(
      "just answer; the platform delivers it where they wrote from",
    );
    expect(body).toContain("use send_message (below)");
  });

  it("a live presence: carries the recipients teaching (find_recipient, @[Name], sent/held)", () => {
    const body = flat(channelsFragment([live])!.body);
    expect(body).toContain("find_recipient");
    expect(body).toContain("@[app]");
    expect(body).toContain('"sent" = delivered. "held" =');
    expect(body).toContain("never promise to follow up on your own");
  });

  it("a live presence: the platform's formatting sentence rides along", () => {
    expect(flat(channelsFragment([live])!.body)).toContain(
      "tables become monospace blocks",
    );
  });

  it("needs_attention still reads as reachable, with the approvals caveat", () => {
    const body = flat(channelsFragment([attention])!.body);
    expect(body).toContain("You are reachable on Slack as @donna");
    expect(body).toContain(
      "Slack approvals and proactive sends are paused for this app",
    );
    expect(body).toContain("you still receive and can answer messages there");
  });

  it("a REMOVED presence: says the app was removed, what restores it, and that a still-listed messaging tool must not be called", () => {
    // The tool list a resumed harness session shows the model is a UNION
    // across attaches (jcode never drops a discovered tool — observed live,
    // 2026-09-15), so the copy cannot promise the tools are gone; it tells
    // the model a listed one no longer works. The platform-tools socket
    // backs that with the same explanation on a call.
    const body = flat(channelsFragment([removed])!.body);
    expect(body).toContain(
      "Your Slack app as @donna in the Acme workspace was removed from the workspace",
    );
    expect(body).toContain("re-attaches it from your Channels page");
    expect(body).toContain(
      "If a send_message or find_recipient tool is still listed for you, it no longer works: do not call it",
    );
    expect(body).not.toContain("return the next time you start");
    expect(body).toContain("do not ask anyone to connect a Slack integration");
    // No recipients TEACHING for a channel that cannot be reached (the tool
    // names appear only in the do-not-call warning).
    expect(body).not.toContain("You are reachable");
    expect(body).not.toContain("search the connected workspace");
  });

  it("a live presence beside a removed one renders the live section", () => {
    const body = flat(channelsFragment([removed, live])!.body);
    expect(body).toContain("You are reachable on Slack");
    expect(body).not.toContain("was removed from the workspace");
  });

  it("falls back gracefully when the platform never learned the handle or the workspace", () => {
    const bare = flat(
      channelsFragment([{ ...live, handle: null, workspaceName: null }])!.body,
    );
    expect(bare).toContain(
      "You are reachable on Slack, through your own Slack app",
    );
    expect(bare).not.toContain("as @");
    expect(bare).not.toContain("in the  workspace");
  });

  it("an unknown provider id (a newer control plane) still renders honestly", () => {
    const body = flat(
      channelsFragment([{ ...live, provider: "teams", handle: "donna" }])!.body,
    );
    expect(body).toContain("You are reachable on Teams as @donna");
    expect(body).toContain("Teams is NOT a gateway connection");
  });
});

describe("channelsTools", () => {
  it("no presence → no tools (teaching and tools arrive together, disappear together)", () => {
    expect(channelsTools([])).toEqual([]);
  });

  it("a live presence → send_message and find_recipient, naming the platform", () => {
    const tools = channelsTools([live]);
    expect(tools.map((t) => t.name)).toEqual([
      "send_message",
      "find_recipient",
    ]);
    expect(tools[0]!.description).toContain("in your Slack workspace");
    expect(tools[1]!.description).toContain("Search your Slack workspace");
    // Control-plane executed: no local handler.
    expect(tools.every((t) => t.execute === undefined)).toBe(true);
  });

  it("needs_attention keeps the tools — messaging works, only approvals are degraded", () => {
    expect(channelsTools([attention]).map((t) => t.name)).toEqual([
      "send_message",
      "find_recipient",
    ]);
  });

  it("only REMOVED presences → no tools, so the model cannot call what cannot deliver", () => {
    expect(channelsTools([removed])).toEqual([]);
  });

  it("the input schemas are the control plane's contract: to+text, query(+kind)", () => {
    const [send, find] = channelsTools([live]);
    expect(send!.inputSchema).toMatchObject({
      required: ["to", "text"],
    });
    expect(find!.inputSchema).toMatchObject({
      required: ["query"],
      properties: { kind: { enum: ["person", "channel"] } },
    });
  });
});
