import { describe, expect, it, vi } from "vitest";

// The SELF-HOST resolution arm — its own file because the edition is baked at
// module load (`lib/env` reads it at import, so the sibling suite's cloud pin
// cannot be undone per-test).
vi.hoisted(() => {
  delete process.env.EDITION;
  delete process.env.NEXT_PUBLIC_EDITION;
});

const calls = vi.hoisted(() => ({ workspaceFindFirst: 0 }));

vi.mock("@onecli/db", () => ({
  db: {
    organizationMember: {
      findFirst: async () => ({ organizationId: "org-first" }),
    },
    workspace: {
      findFirst: async () => {
        calls.workspaceFindFirst += 1;
        return { id: "ws-default", organizationId: "org-first" };
      },
      findUnique: async () => null,
    },
    user: { findUnique: async () => ({ organizationMemberships: [] }) },
  },
}));

import { resolveWorkspaceId } from "./resolve";

const req = (headers: Record<string, string>) =>
  new Request("http://local/v1/org/channels", { headers });

describe("resolveWorkspaceId (onprem)", () => {
  it("an EXPLICIT org scope skips the default-workspace fallback", async () => {
    // Without this, a multi-org self-host user's org-scoped calls (every
    // /org/<id> page, and the Slack finish-install bind) silently resolve to
    // their FIRST-joined org's workspace — the header they sent is ignored.
    const before = calls.workspaceFindFirst;
    const resolved = await resolveWorkspaceId(
      req({ "x-organization-id": "org-second" }),
      "u1",
    );
    expect(resolved).toBeNull();
    expect(calls.workspaceFindFirst).toBe(before);
  });

  it("a header-less local flow keeps the default-workspace fallback", async () => {
    const resolved = await resolveWorkspaceId(req({}), "u1");
    expect(resolved).toBe("ws-default");
  });
});
