// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToolCallRow } from "./tool-call-row";

describe("ToolCallRow", () => {
  it("labels the step in plain words, never with the raw tool name", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        tool={{
          callId: "c0",
          name: "mcp__evil__<img src=x onerror=alert(1)>",
          output: "ok",
        }}
        turnEnded
      />,
    );
    // The label is the shared generic phrase; the raw name only appears
    // inside, as text, once the reader opens the step.
    await user.click(screen.getByText("Used a tool"));
    expect(
      screen.getByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows 'Failed' in red on a failed step, and a red output panel", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolCallRow
        tool={{
          callId: "c1",
          name: "bash",
          output: "ls: cannot open directory '/root': Permission denied",
          isError: true,
        }}
        turnEnded
      />,
    );
    expect(screen.getByText("Ran a command")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toHaveClass("text-red-700");
    await user.click(screen.getByText("Ran a command"));
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(container.querySelector(".bg-red-50")).not.toBeNull();
  });

  it("a command that exits non-zero is Failed too (Claude-style)", () => {
    // The runtime's own trailer for a non-zero exit, while it still
    // reports the step as having run (no isError).
    render(
      <ToolCallRow
        tool={{
          callId: "c4",
          name: "bash",
          output:
            "ls: cannot open directory '/root': Permission denied\n\nExit code: 2",
        }}
        turnEnded
      />,
    );
    expect(screen.getByText("Failed")).toHaveClass("text-red-700");
  });

  it("an exit code quoted mid-output is not this command's", () => {
    render(
      <ToolCallRow
        tool={{
          callId: "c6",
          name: "read",
          output: "## Troubleshooting\nIf you see exit code: 1, retry.\nDone.",
        }}
        turnEnded
      />,
    );
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("a successful step has no status word and no color on the row", () => {
    const { container } = render(
      <ToolCallRow
        tool={{ callId: "c2", name: "bash", output: "ok" }}
        turnEnded
      />,
    );
    expect(screen.queryByText("Failed")).toBeNull();
    const trigger = container.querySelector("button");
    expect(trigger?.className).not.toMatch(/text-(red|green|yellow)-/);
  });

  it("a running step shows the spinner label, not failed", () => {
    render(
      <ToolCallRow tool={{ callId: "c3", name: "bash" }} turnEnded={false} />,
    );
    expect(screen.getByText("Running a command")).toBeInTheDocument();
    expect(screen.getByText("running")).toHaveClass("sr-only");
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("a step with nothing to show is a plain row, not a button", () => {
    render(
      <ToolCallRow
        tool={{ callId: "c7", name: "bash", output: "" }}
        turnEnded
      />,
    );
    expect(screen.getByText("Ran a command")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
