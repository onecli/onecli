// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentAvatar } from "./agent-avatar";

// The pure mark's three faces (image / glyph / pending) and the
// broken-image fallback. Deliberately hook-free: sidebar rows render dozens
// of these, so the component must need NO React Query context — this suite
// rendering without any provider or module mock is itself the pin. The
// image is decorative (alt="" — the agent's name is always adjacent text),
// so queries go by testid, not accessible name.

describe("AgentAvatar", () => {
  it("renders the uploaded image, and the glyph when there is none", () => {
    const { rerender } = render(
      <AgentAvatar agent={{ name: "Deploy Agent", imageUrl: "https://x/a" }} />,
    );
    expect(screen.getByTestId("agent-avatar-image")).toHaveAttribute(
      "src",
      "https://x/a",
    );
    rerender(<AgentAvatar agent={{ name: "Deploy Agent", imageUrl: null }} />);
    expect(screen.queryByTestId("agent-avatar-image")).toBeNull();
  });

  it("falls back to the glyph when the image fails to load — no broken-image mark", () => {
    render(
      <AgentAvatar agent={{ name: "Deploy Agent", imageUrl: "https://x/a" }} />,
    );
    fireEvent.error(screen.getByTestId("agent-avatar-image"));
    expect(screen.queryByTestId("agent-avatar-image")).toBeNull();
  });

  it("shows the spinner while pending — never the stale face", () => {
    render(
      <AgentAvatar
        agent={{ name: "Deploy Agent", imageUrl: "https://x/a" }}
        pending
      />,
    );
    expect(screen.queryByTestId("agent-avatar-image")).toBeNull();
  });
});
