import { describe, expect, it } from "vitest";
import { shellNavRowFor, shellNavRows } from "./shell-nav";

/**
 * The sidebar's rows come from the agent section table, so a row exists
 * only for a section this agent has on this deployment.
 */
describe("shellNavRows", () => {
  it("lists a hosted agent's everyday rows in order, the rest under More", () => {
    const rows = shellNavRows({
      workspaceId: "ws1",
      agent: { id: "ag1", kind: "hosted" },
    });
    expect(rows.filter((r) => !r.more).map((r) => r.id)).toEqual([
      "chat",
      "knowledge",
      "connections",
      "contacts",
      "schedules",
    ]);
    expect(rows.filter((r) => r.more).map((r) => r.id)).toEqual([
      "activity",
      "evals",
      "webhooks",
      "ports",
      "settings",
    ]);
  });

  it("names Apps over the connections segment", () => {
    const rows = shellNavRows({
      workspaceId: "ws1",
      agent: { id: "ag1", kind: "hosted" },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.chat?.href).toBe("/w/ws1/agents/ag1/chat");
    expect(byId.knowledge?.href).toBe("/w/ws1/agents/ag1/knowledge");
    expect(byId.connections?.title).toBe("Apps");
    expect(byId.connections?.href).toBe("/w/ws1/agents/ag1/connections");
    expect(byId.contacts?.href).toBe("/w/ws1/agents/ag1/contacts");
  });

  it("gives a BYO agent only the rows its kind has", () => {
    const rows = shellNavRows({
      workspaceId: "ws1",
      agent: { id: "ag2", kind: "byo" },
    });
    // Apps, and Agent settings (its model) under More.
    expect(rows.map((r) => r.id)).toEqual(["connections", "settings"]);
    expect(rows.find((r) => r.id === "settings")?.href).toBe(
      "/w/ws1/agents/ag2/settings",
    );
  });

  it("drops instance-gated sections the deployment lacks", () => {
    const rows = shellNavRows({
      workspaceId: "ws1",
      agent: { id: "ag1", kind: "hosted" },
      hiddenSections: new Set(["ports"]),
    });
    expect(rows.map((r) => r.id)).not.toContain("ports");
    // Agent settings stays: it holds Models for every deployment, and
    // hides its own SSH block where there is no SSH front door.
    expect(rows.map((r) => r.id)).toContain("settings");
  });

  it("marks Chat as the one prominent row", () => {
    const rows = shellNavRows({
      workspaceId: "ws1",
      agent: { id: "ag1", kind: "hosted" },
    });
    expect(rows.filter((r) => r.prominent).map((r) => r.id)).toEqual(["chat"]);
  });

  it("encodes ids in hrefs", () => {
    const [chat] = shellNavRows({
      workspaceId: "w/s",
      agent: { id: "a?g", kind: "hosted" },
    });
    expect(chat?.href).toBe("/w/w%2Fs/agents/a%3Fg/chat");
  });
});

describe("shellNavRowFor", () => {
  const rows = shellNavRows({
    workspaceId: "ws1",
    agent: { id: "ag1", kind: "hosted" },
  });

  it("finds the row by its section", () => {
    expect(shellNavRowFor(rows, "knowledge")?.id).toBe("knowledge");
    expect(shellNavRowFor(rows, "connections")?.title).toBe("Apps");
    expect(shellNavRowFor(rows, "settings")?.more).toBe(true);
  });

  it("answers null for the index, the theater, old segments and unknown ones", () => {
    expect(shellNavRowFor(rows, "")).toBeNull();
    expect(shellNavRowFor(rows, "computer")).toBeNull();
    // The old segments redirect server side; no row ever sees them.
    expect(shellNavRowFor(rows, "instructions")).toBeNull();
    expect(shellNavRowFor(rows, "nope")).toBeNull();
  });
});
