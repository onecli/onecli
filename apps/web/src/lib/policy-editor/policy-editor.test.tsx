// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Global Policy has no Apply step: the console renders no Apply Changes /
 * review / "Changed" surface, and an edit is a single write the server
 * enforces on return. Rendered through the real editor over a mocked API.
 */

const api = vi.hoisted(() => ({
  listRules: vi.fn(),
  getDefault: vi.fn(),
  setDefault: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return {
    ...real,
    policy: {
      listRules: (...a: unknown[]) => {
        api.calls.push(`GET rules ${JSON.stringify(a)}`);
        return api.listRules(...a);
      },
      getDefault: (...a: unknown[]) => {
        api.calls.push(`GET default ${JSON.stringify(a)}`);
        return api.getDefault(...a);
      },
      setDefault: (...a: unknown[]) => {
        api.calls.push(`PATCH default ${JSON.stringify(a)}`);
        return api.setDefault(...a);
      },
    },
  };
});
vi.mock("@/hooks/use-groups", () => ({ useGroups: () => ({ data: [] }) }));
vi.mock("@/hooks/use-org-members", () => ({
  useOrgMembersList: () => ({ data: [] }),
}));

const { PolicyEditor } = await import("./policy-editor");

const base = {
  scope: "organization",
  status: "draft",
  generation: 0,
  enabled: true,
  description: null,
  rateLimit: null,
  rateLimitWindow: null,
  conditions: null,
  identities: [],
  createdAt: "2026-01-01T00:00:00Z",
};
const rule = {
  ...base,
  id: "r1",
  logicalId: "l1",
  priority: 1,
  isDefault: false,
  source: "custom",
  name: "write ask approval",
  action: "allow",
  requireApproval: true,
  targets: [{ kind: "network", hostPattern: "api.example.com" }],
};
const defaultRule = (action: "allow" | "block") => ({
  ...base,
  id: "d1",
  logicalId: "ld",
  priority: 0,
  isDefault: true,
  source: "default",
  name: "Default Rule",
  action,
  requireApproval: false,
  targets: [],
});

const renderEditor = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PolicyEditor scope="organization" />
    </QueryClientProvider>,
  );

beforeEach(() => {
  api.calls = [];
  api.listRules.mockResolvedValue([rule]);
  api.getDefault.mockResolvedValue(defaultRule("allow"));
  api.setDefault.mockResolvedValue(defaultRule("block"));
});

describe("Global Policy saves without an Apply step", () => {
  it("renders the rules with no Apply Changes, review, or staged chrome", async () => {
    renderEditor();
    expect(await screen.findByText("write ask approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: /add rule/i })).toBeTruthy();
    expect(screen.queryByText(/apply changes/i)).toBeNull();
    expect(screen.queryByText(/last applied/i)).toBeNull();
    expect(screen.queryByText(/^changed$/i)).toBeNull();
    expect(screen.queryByText(/^new$/i)).toBeNull();
    // Only the one rule set is read: no draft-vs-published comparison.
    expect(api.calls.filter((c) => c.startsWith("GET rules"))).toEqual([
      'GET rules ["organization"]',
    ]);
  });

  it("a Default Rule click is one write, nothing to apply afterwards", async () => {
    renderEditor();
    const group = await screen.findByRole("group", { name: /default action/i });
    await userEvent.click(
      within(group).getByRole("button", { name: /blocked/i }),
    );
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledTimes(1));
    expect(api.setDefault).toHaveBeenCalledWith("block", "organization");
    expect(screen.queryByText(/apply changes/i)).toBeNull();
  });
});
