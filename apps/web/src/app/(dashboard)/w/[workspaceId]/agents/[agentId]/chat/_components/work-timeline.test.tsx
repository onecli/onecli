// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@/lib/chat/transcript";
import { groupLabel, settledLabel, WorkTimeline } from "./work-timeline";

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

describe("settledLabel", () => {
  const startedAt = "2026-09-29T12:00:00Z";

  it("says how long the turn worked, from start to finish", () => {
    expect(
      settledLabel({
        startedAt,
        finishedAt: "2026-09-29T12:00:14.600Z",
        stopped: false,
      }),
    ).toBe("Worked for 14s");
    expect(
      settledLabel({
        startedAt,
        finishedAt: "2026-09-29T12:01:05Z",
        stopped: false,
      }),
    ).toBe("Worked for 1m 05s");
  });

  it("says a failed or stopped turn stopped, not that it worked", () => {
    expect(
      settledLabel({
        startedAt,
        finishedAt: "2026-09-29T12:00:09Z",
        stopped: true,
      }),
    ).toBe("Stopped after 9s");
  });

  it("never says 0s: a sub-second turn still worked", () => {
    expect(
      settledLabel({
        startedAt,
        finishedAt: "2026-09-29T12:00:00.300Z",
        stopped: false,
      }),
    ).toBe("Worked for 1s");
  });

  it("gives up (so the header counts steps) without a sane finish time", () => {
    expect(settledLabel({ startedAt, stopped: false })).toBeNull();
    expect(
      settledLabel({ startedAt, finishedAt: null, stopped: false }),
    ).toBeNull();
    // Clock skew: finished before it started.
    expect(
      settledLabel({
        startedAt,
        finishedAt: "2026-09-29T11:59:00Z",
        stopped: false,
      }),
    ).toBeNull();
    expect(
      settledLabel({ startedAt, finishedAt: "not a date", stopped: false }),
    ).toBeNull();
  });
});

describe("WorkTimeline", () => {
  afterEach(() => vi.useRealTimers());

  it("is ONE header row; opening it lists the steps", async () => {
    const user = userEvent.setup();
    render(
      <WorkTimeline
        tools={[
          bash("one"),
          { ...bash("ls: denied"), exitCode: 2 },
          { ...tool("bg", "Error: Task not found"), isError: true },
        ]}
        turnEnded
        startedAt="2026-09-29T12:00:00Z"
      />,
    );
    const header = screen.getByRole("button", { name: /Ran 3 steps/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Ran a command")).toHaveLength(2);
    // Red lives only on the step whose tool failed, never on the header; a
    // command's non-zero exit is a muted status on its own row.
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.getByText("exit 2")).toBeInTheDocument();
    expect(header.className).not.toMatch(/red/);
  });

  it("times the whole turn from its start, not each step, until the answer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:10Z"));
    const startedAt = "2026-09-29T12:00:00Z";
    const { rerender } = render(
      <WorkTimeline tools={[bash()]} turnEnded={false} startedAt={startedAt} />,
    );
    expect(screen.getByText("10s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    // A new step starting does not reset the clock.
    rerender(
      <WorkTimeline
        tools={[bash("done"), bash()]}
        turnEnded={false}
        startedAt={startedAt}
      />,
    );
    expect(screen.getByText("13s")).toBeInTheDocument();
    // The answer arrived: the timer goes away.
    rerender(
      <WorkTimeline
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
      <WorkTimeline
        tools={[bash()]}
        turnEnded={false}
        startedAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText("·")).toHaveAttribute("aria-hidden");
  });

  it("settles to 'Worked for Xs' once the turn finished", () => {
    const { rerender } = render(
      <WorkTimeline
        tools={[bash()]}
        turnEnded={false}
        startedAt="2026-09-29T12:00:00Z"
      />,
    );
    rerender(
      <WorkTimeline
        tools={[bash("ok")]}
        turnEnded
        startedAt="2026-09-29T12:00:00Z"
        finishedAt="2026-09-29T12:00:12Z"
      />,
    );
    expect(
      screen.getByRole("button", { name: /Worked for 12s/ }),
    ).toBeInTheDocument();
  });

  it("lists the work in the order it happened: thoughts, notes, tools", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkTimeline
        tools={[bash("one"), { ...bash("two"), isError: true }]}
        steps={[
          { kind: "thought", text: "Planning the check" },
          { kind: "tool", index: 0 },
          { kind: "note", text: "Now the **config**." },
          { kind: "tool", index: 1 },
        ]}
        turnEnded
        startedAt="2026-09-29T12:00:00Z"
        finishedAt="2026-09-29T12:00:05Z"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Worked for 5s/ }));
    const items = [...container.querySelectorAll("li")];
    expect(items.map((li) => li.dataset.step)).toEqual([
      "thought",
      "tool",
      "note",
      "tool",
    ]);
    expect(items[0]).toHaveTextContent("Planning the check");
    // A note is a log line: no markdown markers, no markup.
    expect(items[2]).toHaveTextContent("Now the config.");
    expect(items[2]!.querySelector("strong")).toBeNull();
    // The failed step's dot is the one red thing.
    const dots = items.map(
      (li) => li.querySelector<HTMLElement>("[data-state]")!.dataset.state,
    );
    expect(dots).toEqual(["aside", "done", "aside", "failed"]);
  });

  it("pulses the running step's dot, and only that one", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkTimeline
        tools={[bash("one"), bash()]}
        turnEnded={false}
        startedAt={new Date().toISOString()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Running 2/ }));
    const running = container.querySelectorAll('[data-state="running"]');
    expect(running).toHaveLength(1);
    expect(running[0]).toHaveClass("motion-safe:animate-pulse");
  });

  it("renders model notes and thoughts as text, never markup", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkTimeline
        tools={[bash("x")]}
        steps={[
          {
            kind: "note",
            text: "<img src=x onerror=alert(1)> [a](javascript:x)",
          },
          { kind: "tool", index: 0 },
        ]}
        turnEnded
        startedAt="2026-09-29T12:00:00Z"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Ran a command/ }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(
      screen.getByText("<img src=x onerror=alert(1)> [a](javascript:x)"),
    ).toBeInTheDocument();
  });

  it("skips a step that points past the tools rather than crashing", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkTimeline
        tools={[bash("x")]}
        steps={[
          { kind: "tool", index: 0 },
          { kind: "tool", index: 5 },
        ]}
        turnEnded
        startedAt="2026-09-29T12:00:00Z"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Ran a command/ }));
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });
});
