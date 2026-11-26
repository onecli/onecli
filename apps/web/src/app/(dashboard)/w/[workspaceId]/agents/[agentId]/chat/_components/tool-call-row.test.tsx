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

  it("a command that exits non-zero shows its status muted, never Failed", () => {
    // `grep` exits 1 when it finds nothing: the command ran, the answer is
    // "no match". The status is a fact on the row, not an alarm.
    render(
      <ToolCallRow
        tool={{
          callId: "c4",
          name: "bash",
          output: "",
          exitCode: 1,
        }}
        turnEnded
      />,
    );
    expect(screen.queryByText("Failed")).toBeNull();
    const status = screen.getByText("exit 1");
    expect(status).toHaveClass("text-muted-foreground");
    expect(status.className).not.toMatch(/red/);
  });

  it("a tool error that also carries a status shows both", () => {
    render(
      <ToolCallRow
        tool={{
          callId: "c5",
          name: "bash",
          output: "boom",
          isError: true,
          exitCode: 2,
        }}
        turnEnded
      />,
    );
    expect(screen.getByText("exit 2")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toHaveClass("text-red-700");
  });

  it("an exit code written in the output is just text, never this row's status", () => {
    // Rows stored before the status became its own field still carry the
    // runtime's trailer as text: they read as plain output, not Failed.
    for (const [callId, output] of [
      ["c6", "## Troubleshooting\nIf you see exit code: 1, retry.\nDone."],
      ["c8", "ls: denied\n\nExit code: 2"],
    ] as const) {
      const { unmount } = render(
        <ToolCallRow tool={{ callId, name: "bash", output }} turnEnded />,
      );
      expect(screen.queryByText("Failed")).toBeNull();
      expect(screen.queryByText(/^exit \d/)).toBeNull();
      unmount();
    }
  });

  it("a successful step has no status word and no color on the row", () => {
    const { container } = render(
      <ToolCallRow
        tool={{ callId: "c2", name: "bash", output: "ok" }}
        turnEnded
      />,
    );
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.queryByText(/^exit \d/)).toBeNull();
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
