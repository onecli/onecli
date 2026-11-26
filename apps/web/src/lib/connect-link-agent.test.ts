import { describe, expect, it } from "vitest";
import {
  readConnectLinkAgent,
  withConnectLinkAgent,
} from "./connect-link-agent";

describe("connect link agent", () => {
  it("round-trips: a door's hand-off is read back as that agent", () => {
    const path = withConnectLinkAgent(
      "/w/ws-1/connections/apps/gmail",
      "agent-7",
    );
    expect(path).toBe(
      "/w/ws-1/connections/apps/gmail?source=agent&agent_id=agent-7",
    );
    const params = new URL(path, "http://localhost").searchParams;
    expect(readConnectLinkAgent(params)).toEqual({
      name: "your agent",
      id: "agent-7",
    });
  });

  it("keeps a gateway link's name, decoded", () => {
    const params = new URLSearchParams(
      "source=agent&agent_name=Mail%20Bot&agent_id=ag-1",
    );
    expect(readConnectLinkAgent(params)).toEqual({
      name: "Mail Bot",
      id: "ag-1",
    });
  });

  it("names no agent without source=agent, and hands off nothing without an id", () => {
    expect(
      readConnectLinkAgent(new URLSearchParams("agent_id=ag-1")),
    ).toBeUndefined();
    expect(withConnectLinkAgent("/w/ws-1/connections/apps/gmail", "")).toBe(
      "/w/ws-1/connections/apps/gmail",
    );
  });
});
