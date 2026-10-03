// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@/lib/chat/transcript";
import { groupLabel, ToolGroup } from "./tool-group";

const tool = (name: string, output?: string): ToolCall => ({
  callId: `${name}-${output ?? "running"}`,
  name,
  ...(output !== undefined && { output }),
});
const bash = (output?: string) => tool("bash", output);

describe("groupLabel", () => {
  it("counts commands and switches tense on completion", () => {
    expect(groupLabel([bash()], true)).toBe("Running a command");
    expect(groupLabel([bash("ok")], false)).toBe("Ran a command");
    expect(groupLabel([bash("ok"), bash()], true)).toBe("Running 2 commands");
    expect(groupLabel([bash("a"), bash("b")], false)).toBe("Ran 2 commands");
  });

  it("counts a run of one kind by what it works on", () => {
    expect(groupLabel([tool("read", "x"), tool("read", "y")], false)).toBe(
      "Read 2 files",
    );
    expect(groupLabel([tool("read")], true)).toBe("Reading a file");
    expect(groupLabel([tool("edit", "x"), tool("write", "y")], false)).toBe(
      "Edited 2 files",
    );
    expect(groupLabel([tool("mcp__onecli__webfetch")], true)).toBe(
      "Fetching a page",
    );
    expect(
      groupLabel([tool("websearch", "x"), tool("agentgrep", "y")], false),
    ).toBe("Ran 2 searches");
  });

  it("counts a mixed run, or tools of no kind, as steps", () => {
    expect(groupLabel([bash("a"), tool("webfetch", "x")], false)).toBe(
      "Ran 2 steps",
    );
    expect(groupLabel([tool("todo", "x"), tool("swarm", "y")], false)).toBe(
      "Ran 2 steps",
    );
  });

  it("names a single step by what it did, the same words as its row", () => {
    // Most real single-step turns are a platform tool (message_agent,
    // find_recipient); "Ran a step" said nothing about them.
    expect(groupLabel([tool("mcp__onecli__message_agent", "ok")], false)).toBe(
      "Messaged another agent",
    );
    expect(groupLabel([tool("mcp__onecli__find_recipient")], true)).toBe(
      "Looking someone up",
    );
    // An unknown tool still never echoes its sandbox-supplied name.
    expect(groupLabel([tool("<img src=x onerror=alert(1)>", "x")], false)).toBe(
      "Used a tool",
    );
  });
});

describe("ToolGroup", () => {
  afterEach(() => vi.useRealTimers());

  it("is ONE header row; opening it lists the steps", async () => {
    const user = userEvent.setup();
    render(
      <ToolGroup
        tools={[bash("one"), bash("ls: denied\n\nExit code: 2")]}
        turnEnded
        startedAt="2026-09-29T12:00:00Z"
      />,
    );
    const header = screen.getByRole("button", { name: /Ran 2 commands/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Ran a command")).toHaveLength(2);
    // Red lives only on the failed step inside, never on the header.
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(header.className).not.toMatch(/red/);
  });

  it("times the whole turn from its start, not each step, until the answer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:10Z"));
    const startedAt = "2026-09-29T12:00:00Z";
    const { rerender } = render(
      <ToolGroup tools={[bash()]} turnEnded={false} startedAt={startedAt} />,
    );
    expect(screen.getByText("10s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    // A new step starting does not reset the clock.
    rerender(
      <ToolGroup
        tools={[bash("done"), bash()]}
        turnEnded={false}
        startedAt={startedAt}
      />,
    );
    expect(screen.getByText("13s")).toBeInTheDocument();
    // The answer arrived: the timer goes away.
    rerender(
      <ToolGroup
        tools={[bash("done"), bash("ok")]}
        turnEnded
        startedAt={startedAt}
      />,
    );
    expect(screen.queryByText(/^\d+s$/)).toBeNull();
    expect(screen.getByText("Ran 2 commands")).toBeInTheDocument();
  });

  it("hides the separator dot from screen readers", () => {
    render(
      <ToolGroup
        tools={[bash()]}
        turnEnded={false}
        startedAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText("·")).toHaveAttribute("aria-hidden");
  });
});
