// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./connect-suggestions", () => ({ ConnectorSuggestions: () => null }));
vi.mock("./chat-markdown", () => ({
  ChatMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}));

const { AgentAnswer } = await import("./agent-answer");

describe("AgentAnswer", () => {
  it("a deliberate [no reply] renders as a quiet note, never the raw token", () => {
    render(<AgentAnswer text="[no reply]" />);
    expect(
      screen.getByText(/Read it and stayed silent\. Nothing was posted/),
    ).toBeDefined();
    expect(screen.queryByText("[no reply]")).toBeNull();
  });

  it("a normal answer renders as the answer", () => {
    render(<AgentAnswer text="Deploy is green." />);
    expect(screen.getByText("Deploy is green.")).toBeDefined();
    expect(screen.queryByText(/stayed silent/)).toBeNull();
  });
});
