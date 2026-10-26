// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionGrants } from "@/lib/api";
import type {
  AgentAccessStatus,
  AgentCredentialStatus,
} from "@/lib/api/policy-visibility";
import { ApiError } from "@/lib/api/client";
import { ConnectionAgentRows } from "./connection-agent-rows";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiDelete: vi.fn<(path: string) => Promise<unknown>>(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("@/lib/api/client")>())
    .ApiError,
  apiGet: mocks.apiGet,
  apiPost: vi.fn(),
  apiPut: mocks.apiPut,
  apiPatch: vi.fn(),
  apiDelete: mocks.apiDelete,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
// The permissions sheet has its own suites; here only its door matters.
vi.mock("./manage-agent-permissions", () => ({
  ManageAgentPermissions: ({ agentId }: { agentId: string }) => (
    <div data-testid="permissions-sheet">{agentId}</div>
  ),
}));

const CONNECTION = {
  id: "conn-1",
  provider: "github-app",
  label: "acme",
  scope: "workspace",
  status: "connected",
  scopes: [],
  metadata: { repos: ["acme/web"] },
  connectedAt: "2026-10-01T00:00:00Z",
};

type Grant = ConnectionGrants["agents"][number];

const grant = (agentId: string, overrides: Partial<Grant> = {}): Grant => ({
  agentId,
  access: "full",
  allow: [],
  ask: [],
  otherReads: "allow",
  otherWrites: "allow",
  resources: null,
  ...overrides,
});

interface AgentFixture {
  id: string;
  name: string;
  access?: AgentAccessStatus;
  credential?: AgentCredentialStatus;
}

const wrap = (ui: ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {ui}
  </QueryClientProvider>
);

/** Agents come from the effective view (the enforced rules); grants from the
 * workspace grants view. A granted agent defaults to a workspace credential. */
const renderRows = (agents: AgentFixture[], grants: Grant[]) => {
  const granted = new Set(grants.map((g) => g.agentId));
  mocks.apiGet.mockImplementation(async (path) =>
    path.endsWith("/effective-agents")
      ? {
          connectionId: CONNECTION.id,
          provider: CONNECTION.provider,
          catalog: true,
          agents: agents.map((a) => ({
            agentId: a.id,
            name: a.name,
            access: a.access ?? (granted.has(a.id) ? "usable" : "none"),
            credential:
              a.credential ??
              (granted.has(a.id)
                ? {
                    status: "viaRule",
                    provenance: [
                      {
                        kind: "rule",
                        scope: "workspace",
                        rule: { logicalId: `g-${a.id}`, name: "grant" },
                      },
                    ],
                  }
                : { status: "none" }),
            decisions: null,
          })),
        }
      : { connectionId: CONNECTION.id, agents: grants },
  );
  mocks.apiPut.mockResolvedValue({});
  mocks.apiDelete.mockResolvedValue(undefined);
  render(wrap(<ConnectionAgentRows connection={CONNECTION} />));
};

afterEach(() => vi.clearAllMocks());

describe("ConnectionAgentRows", () => {
  it("shows each agent's access at a glance", async () => {
    renderRows(
      [
        { id: "a1", name: "Donna" },
        { id: "a2", name: "Pit" },
      ],
      [grant("a2", { access: "custom", allow: ["read", "write"] })],
    );
    expect(await screen.findByText("Custom · 2 tools")).toBeTruthy();
    expect(screen.getByText("1 of 2 on")).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
  });

  it("turning an agent on writes the product default, like every attach toggle", async () => {
    const user = userEvent.setup();
    renderRows([{ id: "a1", name: "Donna" }], []);
    await user.click(
      await screen.findByRole("switch", { name: "Turn on acme for Donna" }),
    );
    await waitFor(() =>
      expect(mocks.apiPut).toHaveBeenCalledWith(
        "/v1/connections/conn-1/grants/agents/a1",
        { access: "default" },
      ),
    );
  });

  it("Undo restores the removed grant exactly: tools, catch-alls and repos", async () => {
    const user = userEvent.setup();
    renderRows(
      [{ id: "a1", name: "Donna" }],
      [
        grant("a1", {
          access: "custom",
          allow: ["read"],
          otherReads: "ask",
          otherWrites: "never",
          resources: { repositories: ["acme/web"] },
        }),
      ],
    );
    await user.click(
      await screen.findByRole("switch", { name: "Turn off acme for Donna" }),
    );
    await waitFor(() =>
      expect(mocks.apiDelete).toHaveBeenCalledWith(
        "/v1/connections/conn-1/grants/agents/a1",
      ),
    );
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    const [, options] = mocks.toast.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    await waitFor(() =>
      expect(mocks.apiPut).toHaveBeenCalledWith(
        "/v1/connections/conn-1/grants/agents/a1",
        {
          access: "custom",
          allow: ["read"],
          ask: [],
          otherReads: "ask",
          otherWrites: "never",
          resources: { repositories: ["acme/web"] },
        },
      ),
    );
  });

  it("an agent the organization grants reads on and locked", async () => {
    renderRows(
      [
        {
          id: "a1",
          name: "Donna",
          access: "usable",
          credential: {
            status: "viaRule",
            provenance: [
              { kind: "rule", scope: "organization", redacted: true },
            ],
          },
        },
      ],
      [],
    );
    expect(
      await screen.findByText("Granted by your organization"),
    ).toBeTruthy();
    const toggle = screen.getByRole("switch", {
      name: "Turn off acme for Donna",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });

  it("an agent the organization blocks says so, with no permissions door", async () => {
    renderRows([{ id: "a1", name: "Donna", access: "blocked" }], [grant("a1")]);
    expect(
      await screen.findByText("Blocked by your organization"),
    ).toBeTruthy();
    expect(screen.queryByText("Full access")).toBeNull();
    // Turning it off (removing intent) stays possible.
    expect(
      screen
        .getByRole("switch", { name: "Turn off acme for Donna" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows two agents, on ones first, and expands the rest in place", async () => {
    const user = userEvent.setup();
    renderRows(
      [
        { id: "a1", name: "Alpha" },
        { id: "a2", name: "Bravo" },
        { id: "a3", name: "Charlie" },
      ],
      [grant("a3")],
    );
    expect(await screen.findByText("Charlie")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Bravo")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Show 1 more/ }));
    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show less/ })).toBeTruthy();
  });

  it("opens that agent's permissions from the access summary", async () => {
    const user = userEvent.setup();
    renderRows([{ id: "a1", name: "Donna" }], [grant("a1")]);
    await user.click(await screen.findByText("Full access"));
    expect((await screen.findByTestId("permissions-sheet")).textContent).toBe(
      "a1",
    );
  });
});

/** A promise the test settles by hand. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("ConnectionAgentRows: instant switches", () => {
  it("the switch flips on click, before the server answers, and stays usable", async () => {
    const user = userEvent.setup();
    renderRows([{ id: "a1", name: "Donna" }], []);
    const put = deferred<unknown>();
    mocks.apiPut.mockReturnValueOnce(put.promise);

    await user.click(
      await screen.findByRole("switch", { name: "Turn on acme for Donna" }),
    );
    const toggle = screen.getByRole("switch", {
      name: "Turn off acme for Donna",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    // The Permissions door is offered at once, with the switch.
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Donna can use acme",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Permissions" }),
      }),
    );
    put.resolve({
      agentId: "a1",
      mode: "grants",
      connections: [],
      secrets: [],
    });
  });

  it("a failed write puts the switch back and says why", async () => {
    const user = userEvent.setup();
    renderRows([{ id: "a1", name: "Donna" }], []);
    const put = deferred<unknown>();
    mocks.apiPut.mockReturnValueOnce(put.promise);

    await user.click(
      await screen.findByRole("switch", { name: "Turn on acme for Donna" }),
    );
    expect(
      screen
        .getByRole("switch", { name: "Turn off acme for Donna" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    put.reject(new ApiError("Your plan doesn't allow this", 403));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Turn on acme for Donna" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Couldn't turn on .+ for Donna$/),
      expect.objectContaining({
        description: "Your plan doesn't allow this",
        // Replaces the click's own toast for this pair (no stale Undo).
        id: "grant:a1:connection:conn-1",
      }),
    );
    // A 4xx refusal answers the same way again: no Retry.
    const [, options] = mocks.toast.error.mock.calls[0] as [
      string,
      { action?: unknown },
    ];
    expect(options.action).toBeUndefined();
  });

  it("a network failure offers Retry", async () => {
    const user = userEvent.setup();
    renderRows([{ id: "a1", name: "Donna" }], []);
    mocks.apiPut.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await user.click(
      await screen.findByRole("switch", { name: "Turn on acme for Donna" }),
    );
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    const [, options] = mocks.toast.error.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(options.action.label).toBe("Retry");
    mocks.apiPut.mockResolvedValueOnce({});
    options.action.onClick();
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(2));
  });

  it("on → off → on reaches the server as three writes, in click order", async () => {
    const user = userEvent.setup();
    renderRows([{ id: "a1", name: "Donna" }], []);
    const first = deferred<unknown>();
    const calls: string[] = [];
    mocks.apiPut.mockImplementation(async () => {
      calls.push("put");
      if (calls.length === 1) await first.promise;
      return {};
    });
    mocks.apiDelete.mockImplementation(async () => {
      calls.push("delete");
    });

    await user.click(
      await screen.findByRole("switch", { name: "Turn on acme for Donna" }),
    );
    await user.click(
      screen.getByRole("switch", { name: "Turn off acme for Donna" }),
    );
    await user.click(
      screen.getByRole("switch", { name: "Turn on acme for Donna" }),
    );
    // The screen already shows the last click.
    expect(
      screen
        .getByRole("switch", { name: "Turn off acme for Donna" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // The first write is slow; nothing behind it has overtaken it.
    expect(calls).toEqual(["put"]);
    first.resolve({});
    await waitFor(() => expect(calls).toEqual(["put", "delete", "put"]));
  });

  it("a toggled row keeps its place instead of jumping to the top", async () => {
    const user = userEvent.setup();
    renderRows(
      [
        { id: "a1", name: "Alpha" },
        { id: "a2", name: "Bravo" },
      ],
      [],
    );
    mocks.apiPut.mockReturnValueOnce(deferred<unknown>().promise);
    const names = () =>
      screen
        .getAllByRole("switch")
        .map((s) => s.getAttribute("aria-label") ?? "");
    expect(await screen.findByText("Bravo")).toBeTruthy();
    expect(names()).toEqual([
      "Turn on acme for Alpha",
      "Turn on acme for Bravo",
    ]);
    await user.click(
      screen.getByRole("switch", { name: "Turn on acme for Bravo" }),
    );
    // On, but still second: "on first" applies on the next visit.
    expect(names()).toEqual([
      "Turn on acme for Alpha",
      "Turn off acme for Bravo",
    ]);
  });
});
