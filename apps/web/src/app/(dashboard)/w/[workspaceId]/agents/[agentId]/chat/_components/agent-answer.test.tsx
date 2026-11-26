// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./connect-suggestions", () => ({ ConnectorSuggestions: () => null }));
vi.mock("./chat-markdown", () => ({
  ChatMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}));

const { AgentAnswer } = await import("./agent-answer");

const copyButton = () => screen.queryByRole("button", { name: "Copy reply" });

describe("AgentAnswer", () => {
  beforeEach(() => {
    // Reduced motion: the text is shown whole on arrival (the reveal's
    // pacing has its own suite), so "last word on screen" is immediate.
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
  });

  it("a deliberate [no reply] renders as a quiet note, never the raw token", () => {
    render(<AgentAnswer text="[no reply]" />);
    expect(
      screen.getByText(/Read it and stayed silent\. Nothing was posted/),
    ).toBeDefined();
    expect(screen.queryByText("[no reply]")).toBeNull();
    // Nothing to copy.
    expect(copyButton()).toBeNull();
  });

  it("a normal answer renders as the answer", () => {
    render(<AgentAnswer text="Deploy is green." />);
    expect(screen.getByText("Deploy is green.")).toBeDefined();
    expect(screen.queryByText(/stayed silent/)).toBeNull();
  });

  it("copies the final answer's markdown, as the agent wrote it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<AgentAnswer text="**Deploy** is `green`." />);
    await user.click(copyButton()!);
    expect(writeText).toHaveBeenCalledWith("**Deploy** is `green`.");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("offers no actions under a draft or the lead: only a final answer", () => {
    const { rerender } = render(
      <AgentAnswer text="Still writing this" draft live />,
    );
    expect(copyButton()).toBeNull();
    rerender(<AgentAnswer text="I'll check the logs." role="lead" />);
    expect(copyButton()).toBeNull();
    // The draft settles into the answer: now there is something to copy.
    rerender(<AgentAnswer text="Still writing this" live />);
    expect(copyButton()).not.toBeNull();
  });

  it("shows the copy and time line only on hover or focus, with a short fade", () => {
    const { container } = render(
      <AgentAnswer text="Done." sentAt="2026-08-05T10:00:00Z" />,
    );
    const row = container.querySelector<HTMLElement>(
      '[data-slot="answer-actions"]',
    )!;
    // Hidden on hover devices until the message is hovered or focused…
    expect(row.className).toContain("[@media(hover:hover)]:opacity-0");
    expect(row.className).toContain(
      "[@media(hover:hover)]:group-hover/msg:opacity-100",
    );
    expect(row.className).toContain(
      "[@media(hover:hover)]:group-focus-within/msg:opacity-100",
    );
    // …fading in and out briefly, and not at all under reduced motion.
    expect(row.className).toContain("transition-opacity");
    expect(row.className).toContain("duration-150");
    // A short wait before showing, so a passing cursor does not flicker it.
    expect(row.className).toContain(
      "[@media(hover:hover)]:group-hover/msg:delay-150",
    );
    expect(row.className).toContain("motion-reduce:transition-none");
  });

  it("shows when the answer was sent, as a machine-readable time", () => {
    const { container } = render(
      <AgentAnswer text="Done." sentAt="2026-08-05T10:00:00Z" />,
    );
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("datetime", "2026-08-05T10:00:00Z");
    expect(time?.getAttribute("title")).toMatch(/2026/);
  });
});
