// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGrants } from "@/lib/api";
import type { EffectiveCredentialsResult } from "@/lib/api/policy-visibility";
import {
  agentActiveSets,
  useAgentActiveConnections,
} from "./use-agent-active-connections";

/** "Active for this agent" = its own grant, or an organization grant. The
 * tabs, their badges and the rail all read this one rule. */

const grants: AgentGrants = {
  agentId: "agent-1",
  mode: "grants",
  connections: [
    {
      connectionId: "conn-own",
      provider: "github",
      label: null,
      scope: "workspace",
      access: "full",
      allow: [],
      ask: [],
      otherReads: "ask",
      otherWrites: "ask",
      resources: null,
    },
  ],
  secrets: [
    { secretId: "sec-own", name: "own", type: "generic", scope: "workspace" },
  ],
};

const credentials: EffectiveCredentialsResult = {
  agentId: "agent-1",
  mode: "selective",
  connections: [
    {
      kind: "connection",
      id: "conn-org",
      label: null,
      provider: "github",
      status: "usable",
      orgBlocked: false,
      provenance: [{ kind: "rule", scope: "organization", redacted: true }],
    },
    // Injected by a workspace rule, not an org grant: not active by itself.
    {
      kind: "connection",
      id: "conn-ws-rule",
      label: null,
      provider: "github",
      status: "usable",
      orgBlocked: false,
      provenance: [
        {
          kind: "rule",
          scope: "workspace",
          rule: { logicalId: "r1", name: "r" },
        },
      ],
    },
  ],
  secrets: [
    {
      kind: "secret",
      id: "sec-org",
      name: "org",
      host: "api.example.com",
      status: "usable",
      provenance: [{ kind: "rule", scope: "organization", redacted: true }],
    },
  ],
};

describe("agentActiveSets", () => {
  it("counts an own grant or an organization grant, nothing else", () => {
    const { isActiveApp, isActiveSecret } = agentActiveSets(
      grants,
      credentials,
    );
    expect(isActiveApp("conn-own")).toBe(true);
    expect(isActiveApp("conn-org")).toBe(true);
    expect(isActiveApp("conn-ws-rule")).toBe(false);
    expect(isActiveApp("conn-off")).toBe(false);
    expect(isActiveSecret("sec-own")).toBe(true);
    expect(isActiveSecret("sec-org")).toBe(true);
    expect(isActiveSecret("sec-off")).toBe(false);
  });

  it("is empty before the reads land", () => {
    const { isActiveApp, isActiveSecret } = agentActiveSets(
      undefined,
      undefined,
    );
    expect(isActiveApp("conn-own")).toBe(false);
    expect(isActiveSecret("sec-own")).toBe(false);
  });
});

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
}));
vi.mock("@/lib/api/client", () => ({
  apiGet: mocks.apiGet,
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

const connection = (id: string, status = "connected") => ({
  id,
  provider: "github",
  label: id,
  status,
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-10-01T00:00:00Z",
});
const secret = (id: string, type = "generic") => ({ id, name: id, type });

afterEach(() => vi.clearAllMocks());

describe("useAgentActiveConnections", () => {
  it("counts connected apps and custom secrets that are active", async () => {
    mocks.apiGet.mockImplementation(async (path) => {
      if (path === "/v1/connections")
        return [
          connection("conn-own"),
          connection("conn-org"),
          connection("conn-off"),
          // Active by grant, but disconnected: not counted.
          connection("conn-org-gone", "disconnected"),
        ];
      if (path === "/v1/secrets")
        return [
          secret("sec-own"),
          secret("sec-off"),
          // LLM keys live under Models, not Connections.
          secret("sec-org", "anthropic"),
        ];
      if (path === "/v1/agents/agent-1/grants") return grants;
      if (path === "/v1/agents/agent-1/effective-credentials")
        return {
          ...credentials,
          connections: [
            ...credentials.connections,
            { ...credentials.connections[0], id: "conn-org-gone" },
          ],
        };
      throw new Error(`unexpected GET ${path}`);
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAgentActiveConnections("agent-1"), {
      wrapper,
    });
    expect(result.current).toEqual({
      appCount: undefined,
      secretCount: undefined,
    });
    await waitFor(() =>
      expect(result.current).toEqual({ appCount: 2, secretCount: 1 }),
    );
  });
});
