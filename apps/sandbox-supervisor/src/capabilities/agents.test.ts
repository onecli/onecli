import { describe, expect, it } from "vitest";
import type { AgentPeerWire } from "@onecli/agent-protocol";
import { agentsFragment, agentsTools } from "./agents";

const ray: AgentPeerWire = { name: "Ray" };
const zoe: AgentPeerWire = { name: "Zoe" };

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("agentsFragment", () => {
  it("renders NOTHING for an agent with no peers — silence, not an empty heading", () => {
    expect(agentsFragment([])).toBeNull();
  });

  it("names every peer as standing fact and teaches only the mechanism", () => {
    const fragment = agentsFragment([ray, zoe]);
    expect(fragment?.id).toBe("agents");
    expect(fragment?.title).toBe("Other agents");
    const body = flat(fragment!.body);
    expect(body).toContain("Other OneCLI agents you can message: Ray, Zoe.");
    expect(body).toContain('"sent" = delivered');
    expect(body).toContain('"held" = the owners were asked');
    expect(body).toContain("its own conversation with you");
    expect(body).toContain("prefixed `Name (agent):`");
    // A person's ask opens a TASK: the exchange stays in the pair
    // conversation, the report is the one thing that reaches the person.
    expect(body).toContain("opens a task for the person");
    expect(body).toContain("the person does not see it");
    expect(body).toContain("call complete_task there");
    expect(body).toContain("reaches them on its own");
    expect(body).toContain("fixed number of messages per side");
    // Nothing about replies landing in the person's conversation (5b's
    // home-wake is gone).
    expect(body).not.toContain("also arrives here");
    // Bare mechanism: no coaching on when or how to talk to a peer.
    expect(body).not.toMatch(/should|avoid|only if|be careful/i);
  });
});

describe("agentsTools", () => {
  it("no peers → no tool (teaching and tool arrive together, disappear together)", () => {
    expect(agentsTools([])).toEqual([]);
  });

  it("a peer → message_agent and complete_task, control-plane executed", () => {
    const tools = agentsTools([ray]);
    expect(tools.map((t) => t.name)).toEqual([
      "message_agent",
      "complete_task",
    ]);
    const message = tools[0]!.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(message.required).toEqual(["to", "text"]);
    expect(Object.keys(message.properties)).toEqual(["to", "text"]);
    const complete = tools[1]!.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(complete.required).toEqual(["report"]);
    expect(Object.keys(complete.properties)).toEqual(["report", "peer"]);
    // The description keeps the two "task" tool families apart.
    expect(tools[1]!.description).toContain("Not for scheduled tasks");
    // Control-plane executed: consent, fence and delivery live there.
    for (const tool of tools) expect(tool.execute).toBeUndefined();
  });
});
