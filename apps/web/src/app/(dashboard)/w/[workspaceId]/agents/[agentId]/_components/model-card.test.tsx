// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModels } from "@/lib/api/types";

const mocks = vi.hoisted(() => ({ useAgentModels: vi.fn(), mutate: vi.fn() }));

vi.mock("@/hooks/use-agents", () => ({
  useAgentModels: mocks.useAgentModels,
  useUpdateAgentModel: () => ({ mutate: mocks.mutate, isPending: false }),
}));

// Radix Select needs these in jsdom.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const { ModelCard } = await import("./model-card");

const view = (overrides: Partial<AgentModels> = {}): AgentModels => ({
  provider: "anthropic",
  providerLabel: "Anthropic",
  providerScope: "workspace",
  models: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", source: "live" },
    { id: "claude-opus-5", label: "Claude Opus 5", source: "live" },
  ],
  efforts: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  defaults: { model: "claude-sonnet-5", effort: null },
  selected: { model: "claude-sonnet-5", effort: null, overridden: false },
  degraded: false,
  ...overrides,
});

beforeEach(() => {
  mocks.mutate.mockClear();
});

const ready = (data: AgentModels) =>
  mocks.useAgentModels.mockReturnValue({
    data,
    isPending: false,
    isError: false,
  });

describe("ModelCard", () => {
  it("says what the agent runs and WHY, when nobody has chosen", () => {
    // The point of the card: a provider-driven default should read as a
    // consequence of the connected key, not as a mystery. The provider is
    // named ONCE — by the connected line, not the subtitle too.
    ready(view());
    render(<ModelCard agentId="a1" />);
    expect(screen.getByText("Running claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("Anthropic key connected")).toBeVisible();
    expect(screen.getByText(/The default for this key/)).toBeVisible();
  });

  it("attributes the choice to the user once one is made", () => {
    ready(
      view({
        selected: { model: "claude-opus-5", effort: "high", overridden: true },
      }),
    );
    render(<ModelCard agentId="a1" />);
    expect(screen.getByText("Running claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText(/Your choice/)).toBeVisible();
  });

  it("asks for a key instead of showing a picker that cannot pick", () => {
    ready(
      view({
        provider: null,
        providerLabel: null,
        models: [],
        efforts: [],
        selected: { model: "", effort: null, overridden: false },
      }),
    );
    render(<ModelCard agentId="a1" />);
    expect(screen.getByText("No model key connected")).toBeInTheDocument();
    expect(screen.queryByText(/Anthropic key connected/)).toBeNull();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("hides the thinking control for a provider that has no levels", () => {
    ready(view({ efforts: [] }));
    render(<ModelCard agentId="a1" />);
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).toBeNull();
  });

  it("offers no Save until something is actually changed", () => {
    ready(view());
    render(<ModelCard agentId="a1" />);
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });

  it("saves only the field that changed, and clears an override as null", async () => {
    const user = userEvent.setup();
    ready(view());
    render(<ModelCard agentId="a1" />);

    await user.click(screen.getByLabelText("Model"));
    await user.click(screen.getByRole("option", { name: "Claude Opus 5" }));
    await user.click(screen.getByRole("button", { name: /Save/ }));

    // Effort was never touched, so it must not be sent — sending it would
    // write the resolved value back as an explicit override.
    expect(mocks.mutate).toHaveBeenCalledWith(
      { agentId: "a1", model: "claude-opus-5" },
      expect.anything(),
    );
  });

  it("withdraws Save when the user picks their way back to the stored value", async () => {
    // A→B→A. Saving here would respawn the container and stop whatever the
    // agent is doing, to write exactly what is already stored.
    const user = userEvent.setup();
    ready(view());
    render(<ModelCard agentId="a1" />);

    await user.click(screen.getByLabelText("Model"));
    await user.click(screen.getByRole("option", { name: "Claude Opus 5" }));
    expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();

    await user.click(screen.getByLabelText("Model"));
    await user.click(
      screen.getByRole("option", { name: /Default \(claude-sonnet-5\)/ }),
    );
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });
});
