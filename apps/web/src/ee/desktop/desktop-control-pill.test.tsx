// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "./api";
import { DesktopControlPill } from "./desktop-control-pill";

const state = (overrides: Partial<DesktopState> = {}): DesktopState => ({
  available: true,
  sandboxState: "awake",
  viewHost: "d-andy-ab12.preview.example",
  controlHost: null,
  controller: null,
  request: null,
  you: { controlling: false },
  ...overrides,
});
const driving = state({
  controlHost: "d-andy-ab12-ctl.preview.example",
  controller: { userId: "u1", name: "Me", since: "2026-10-17T00:00:00Z" },
  you: { controlling: true },
});

type Props = React.ComponentProps<typeof DesktopControlPill>;
const props = (overrides: Partial<Props> = {}): Props => ({
  state: state(),
  status: "connected",
  taking: false,
  stopping: false,
  onTake: vi.fn(),
  onStop: vi.fn(),
  ...overrides,
});

afterEach(cleanup);

describe("DesktopControlPill", () => {
  it("is a toolbar: watching offers Take control, enabled only once the stream is up", () => {
    const { rerender } = render(
      <DesktopControlPill {...props({ status: "connecting" })} />,
    );
    expect(
      screen.getByRole("toolbar", { name: "Desktop control" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Watching")).toBeInTheDocument();
    const take = screen.getByRole("button", { name: "Take control" });
    expect(take).toBeDisabled();
    expect(take).not.toHaveAttribute("aria-pressed");
    rerender(<DesktopControlPill {...props()} />);
    expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled();
  });

  it("someone else driving: their name, and no way to take it", () => {
    render(
      <DesktopControlPill
        {...props({
          state: state({
            controller: {
              userId: "u2",
              name: "Sam Lee",
              since: "2026-10-17T00:00:00Z",
            },
          }),
        })}
      />,
    );
    expect(screen.getByText("Sam Lee is in control")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take control" })).toBeDisabled();
  });

  it("driving: one Stop that hands back at once, with no note and no second step", async () => {
    const onStop = vi.fn();
    render(<DesktopControlPill {...props({ state: driving, onStop })} />);
    expect(screen.getByText("You’re in control")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Take control" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("Stop shows its request in flight and cannot be pressed twice", () => {
    render(
      <DesktopControlPill {...props({ state: driving, stopping: true })} />,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("carries the chat toggle only where the host offers one, as a pressed state", async () => {
    render(<DesktopControlPill {...props()} />);
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
    cleanup();
    const onToggle = vi.fn();
    render(
      <DesktopControlPill {...props({ chat: { open: true, onToggle } })} />,
    );
    const chat = screen.getByRole("button", { name: "Chat" });
    expect(chat).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chat);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("offers Keyboard only while driving, and only when the host can raise one", async () => {
    const onKeyboard = vi.fn();
    const { rerender } = render(
      <DesktopControlPill {...props({ onKeyboard })} />,
    );
    expect(screen.queryByRole("button", { name: "Keyboard" })).toBeNull();
    rerender(<DesktopControlPill {...props({ state: driving, onKeyboard })} />);
    const button = screen.getByRole("button", { name: "Keyboard" });
    // Touch only: hidden unless the pointer is coarse (a phone, a tablet).
    expect(button.className).toContain("hidden");
    expect(button.className).toContain("pointer-coarse:inline-flex");
    await userEvent.click(button);
    expect(onKeyboard).toHaveBeenCalledTimes(1);
    rerender(<DesktopControlPill {...props({ state: driving })} />);
    expect(screen.queryByRole("button", { name: "Keyboard" })).toBeNull();
  });
});
