// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent settings ends with a Danger zone: a Delete agent button that opens
 * the kebab's own confirm (Slack acknowledgements included) and lands on
 * the workspace home after the delete.
 */

const remove = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/w/ws-1/agents/ag-1/settings",
}));
vi.mock("@/hooks/use-agents", () => ({
  useDeleteAgent: () => ({ mutateAsync: remove, isPending: false }),
}));
vi.mock("@/hooks/use-instance", () => ({ useInstance: () => null }));
vi.mock("@/lib/dashboard/scroll-to-hash", () => ({ ScrollToHash: () => null }));
vi.mock("@dashboard/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("../../_components/agent-details-dialog", () => ({
  AgentFacts: () => null,
}));
vi.mock("../../_components/models-section", () => ({
  ModelsSection: () => null,
}));
vi.mock("../../ssh/_components/ssh-section", () => ({
  SshSection: () => null,
}));

const agent = {
  id: "ag-1",
  name: "Dana",
  kind: "byo" as const,
  channels: [] as { provider: string; identityName?: string | null }[],
};
vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => agent,
}));

const { AgentSettingsSection } = await import("./agent-settings-section");

beforeEach(() => {
  remove.mockReset();
  replace.mockReset();
  agent.channels = [];
});

describe("Agent settings: Danger zone", () => {
  it("is the last block, with a Delete agent button", () => {
    render(<AgentSettingsSection />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.at(-1)).toHaveTextContent("Danger zone");
    expect(
      screen.getByRole("button", { name: /delete agent/i }),
    ).toBeInTheDocument();
  });

  it("confirms, deletes, then lands on the workspace home", async () => {
    remove.mockResolvedValue(undefined);
    render(<AgentSettingsSection />);
    await userEvent.click(
      screen.getByRole("button", { name: /delete agent/i }),
    );
    expect(screen.getByText("Delete agent?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(remove).toHaveBeenCalledWith("ag-1");
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/w/ws-1"));
  });

  it("asks to acknowledge a connected Slack app before Delete unlocks", async () => {
    agent.channels = [{ provider: "slack", identityName: "dana" }];
    render(<AgentSettingsSection />);
    await userEvent.click(
      screen.getByRole("button", { name: /delete agent/i }),
    );

    const confirm = screen.getByRole("button", { name: /^delete$/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
  });
});
