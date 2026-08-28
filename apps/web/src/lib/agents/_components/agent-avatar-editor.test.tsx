// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The editor door: upload/remove wiring and the provider-generic settings
// deep link — the menu item renders from a server-projected `settingsUrl`,
// never from a hardcoded provider conditional, so provider #2 extends the
// data, not this component.

const hook = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock("@/hooks/use-agents", () => ({
  useUpdateAgentImage: () => ({
    mutate: hook.mutate,
    isPending: hook.isPending,
  }),
}));

const { AgentAvatarEditor } = await import("./agent-avatar-editor");

const IMG = "https://api.example.com/v1/agent-images/ag1/aaa";
const agent = (
  over?: Partial<Parameters<typeof AgentAvatarEditor>[0]["agent"]>,
) => ({
  id: "ag1",
  name: "Deploy Agent",
  imageUrl: IMG,
  channels: [
    { provider: "slack", settingsUrl: "https://api.slack.com/apps/A1/general" },
  ],
  ...over,
});

beforeEach(() => {
  hook.mutate.mockReset();
  hook.isPending = false;
});

describe("AgentAvatarEditor", () => {
  it("disables the door while the mutation (crop included) runs", () => {
    hook.isPending = true;
    render(<AgentAvatarEditor agent={agent()} />);
    expect(
      screen.getByRole("button", { name: "Change agent image" }),
    ).toBeDisabled();
  });

  it("offers the provider settings deep link ONLY when a channel serves one", async () => {
    const user = userEvent.setup();
    render(<AgentAvatarEditor agent={agent()} />);
    await user.click(
      screen.getByRole("button", { name: "Change agent image" }),
    );
    const link = await screen.findByRole("menuitem", {
      name: /Set as Slack app icon/,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://api.slack.com/apps/A1/general",
    );
  });

  it("renders NO settings item for a channel without a settingsUrl", async () => {
    const user = userEvent.setup();
    render(
      <AgentAvatarEditor
        agent={agent({ channels: [{ provider: "slack" }] })}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Change agent image" }),
    );
    await screen.findByRole("menuitem", { name: /Replace image/ });
    expect(screen.queryByRole("menuitem", { name: /app icon/ })).toBeNull();
  });

  it("removes through the mutation with file: null", async () => {
    const user = userEvent.setup();
    render(<AgentAvatarEditor agent={agent()} />);
    await user.click(
      screen.getByRole("button", { name: "Change agent image" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Remove image/ }),
    );
    expect(hook.mutate).toHaveBeenCalledWith({ agentId: "ag1", file: null });
  });
});
