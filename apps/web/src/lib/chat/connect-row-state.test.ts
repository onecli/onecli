import { describe, expect, it } from "vitest";
import type { Connection } from "@/lib/api/types";
import { resolveConnectRow } from "./connect-row-state";

const account = (id: string, extra: Partial<Connection> = {}): Connection => ({
  id,
  provider: "gmail",
  label: `${id}@example.com`,
  status: "connected",
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-08-01T00:00:00Z",
  ...extra,
});

const resolve = (
  overrides: Partial<Parameters<typeof resolveConnectRow>[0]> = {},
) =>
  resolveConnectRow({
    provider: "gmail",
    kind: "connect",
    connections: [],
    heldConnectionIds: new Set(),
    ...overrides,
  });

describe("resolveConnectRow", () => {
  it("a workspace account this agent does NOT hold is not 'connected' for it", () => {
    // The reported bug: a new agent with only GitHub turned on read
    // "Gmail · Connected" because someone else's Gmail sat in the
    // workspace. The workspace pool alone says nothing about this agent.
    expect(
      resolve({
        connections: [account("ws-gmail")],
        heldConnectionIds: new Set(["some-github"]),
      }),
    ).toEqual({ type: "not_attached" });
  });

  it("an account this agent holds is attached, and named", () => {
    const held = account("mine");
    expect(
      resolve({
        connections: [account("other"), held],
        heldConnectionIds: new Set(["mine"]),
      }),
    ).toEqual({ type: "attached", primary: held, connections: [held] });
  });

  it("names the account this agent holds, not the first one listed", () => {
    // MUTATION-PROOF: pick `pool[0]` instead of the held account and Manage
    // would open the permissions of an account this agent cannot use.
    const state = resolve({
      connections: [account("first"), account("second")],
      heldConnectionIds: new Set(["second"]),
    });
    expect(state.type === "attached" && state.primary.id).toBe("second");
  });

  it("offers Connect only when the workspace has no connected account", () => {
    expect(resolve()).toEqual({ type: "connect" });
    expect(
      resolve({ connections: [account("broken", { status: "error" })] }),
    ).toEqual({ type: "connect" });
    expect(
      resolve({ connections: [account("gh", { provider: "github" })] }),
    ).toEqual({ type: "connect" });
  });

  it("claims nothing while this agent's access is unknown", () => {
    const connections = [account("ws-gmail")];
    expect(resolve({ connections, heldConnectionIds: "pending" })).toEqual({
      type: "unknown",
      failed: false,
    });
    expect(resolve({ connections, heldConnectionIds: "failed" })).toEqual({
      type: "unknown",
      failed: true,
    });
  });

  it("never says Connect over an unread pool", () => {
    // An unloaded list is not an empty one: Connect here could duplicate an
    // account this agent already holds.
    expect(resolve({ connections: "pending" })).toEqual({
      type: "unknown",
      failed: false,
    });
    expect(resolve({ connections: "failed" })).toEqual({
      type: "unknown",
      failed: true,
    });
  });

  it("prefers a healthy account; needs reconnect only when every held one is refused", () => {
    const dead = account("dead", { reauthRequiredAt: "2026-10-01T00:00:00Z" });
    const live = account("live");
    const both = resolve({
      connections: [dead, live],
      heldConnectionIds: new Set(["dead", "live"]),
    });
    expect(both.type === "attached" && both.primary.id).toBe("live");

    expect(
      resolve({ connections: [dead], heldConnectionIds: new Set(["dead"]) }),
    ).toEqual({ type: "needs_reconnect", connection: dead });
  });

  it("a refused account this agent does not hold is still just not attached", () => {
    expect(
      resolve({
        connections: [
          account("dead", { reauthRequiredAt: "2026-10-01T00:00:00Z" }),
        ],
      }),
    ).toEqual({ type: "not_attached" });
  });

  it("a reconnect link acts on the account it names", () => {
    const named = account("named", {
      reauthRequiredAt: "2026-10-01T00:00:00Z",
    });
    expect(
      resolve({
        kind: "reconnect",
        connectionId: "named",
        connections: [account("other"), named],
        heldConnectionIds: new Set(["other"]),
      }),
    ).toEqual({ type: "needs_reconnect", connection: named });
  });

  it("a reconnect link whose account recovered falls back to the agent's state", () => {
    expect(
      resolve({
        kind: "reconnect",
        connectionId: "named",
        connections: [account("named")],
        heldConnectionIds: new Set(["named"]),
      }).type,
    ).toBe("attached");
  });

  it("an attach row stays attach-shaped even over a refused account", () => {
    // The gateway said THIS agent lacks a grant; a reconnect would not fix
    // that, so the row reports what the agent holds instead.
    const dead = account("dead", { reauthRequiredAt: "2026-10-01T00:00:00Z" });
    expect(
      resolve({
        kind: "attach",
        connections: [dead],
        heldConnectionIds: new Set(["dead"]),
      }).type,
    ).toBe("attached");
  });

  it("an org-access link reads the refusal live, from whichever account records it", () => {
    const github = (id: string, metadata: unknown = null) =>
      account(id, { provider: "github", metadata });
    const refused = github("work", {
      githubOrgAccess: { acme: { reason: "approval_required" } },
    });
    const state = resolve({
      provider: "github",
      kind: "org_access",
      org: "Acme",
      connections: [github("personal"), refused],
    });
    expect(state).toEqual({
      type: "org_access",
      connection: refused,
      issue: { org: "acme", reason: "approval_required" },
    });

    // Cleared by the gateway: back to the agent's own state.
    expect(
      resolve({
        provider: "github",
        kind: "org_access",
        org: "acme",
        connections: [github("work")],
        heldConnectionIds: new Set(["work"]),
      }).type,
    ).toBe("attached");
  });
});
