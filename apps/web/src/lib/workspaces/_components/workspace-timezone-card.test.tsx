// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The timezone card's contract with the API: it only ever submits a change
 * (the same stored value re-sent would cost every agent in the workspace its
 * container), null means "platform default", and a stored zone this browser
 * cannot list stays selectable instead of being silently replaced.
 */

const state = vi.hoisted(() => ({
  calls: [] as { id: string; timezone: string | null }[],
}));

vi.mock("@/hooks/use-workspaces", () => ({
  useSetWorkspaceTimezone: () => ({
    isPending: false,
    mutateAsync: async (input: { id: string; timezone: string | null }) => {
      state.calls.push(input);
      return { id: input.id, timezone: input.timezone };
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The card lists every runtime zone (~430) into a Radix Select at module
// load. A short fixed list keeps the renders cheap and makes the "stored zone
// this browser lacks" premise independent of the runtime's ICU data. It must
// be in place before the import below, which computes the list.
const realSupportedValuesOf = Intl.supportedValuesOf.bind(Intl);
vi.spyOn(Intl, "supportedValuesOf").mockImplementation((key) =>
  key === "timeZone"
    ? ["Asia/Calcutta", "Asia/Jerusalem", "Asia/Tokyo", "Europe/London", "UTC"]
    : realSupportedValuesOf(key),
);

const { WorkspaceTimezoneCard } = await import("./workspace-timezone-card");

beforeAll(() => {
  // Radix's Select drives its listbox through pointer-capture and scroll
  // APIs jsdom does not implement; stubbing them is what makes the
  // component's real interaction path testable at all.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  state.calls = [];
});
afterEach(cleanup);

describe("WorkspaceTimezoneCard", () => {
  it("starts on the stored zone with nothing to save", () => {
    render(
      <WorkspaceTimezoneCard
        workspaceId="ws-1"
        currentTimezone="Asia/Jerusalem"
      />,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Asia/Jerusalem");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("shows the platform default when nothing is stored", () => {
    render(<WorkspaceTimezoneCard workspaceId="ws-1" currentTimezone={null} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Platform default");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("keeps a stored zone this browser's list lacks on the trigger", () => {
    // Another spelling of a listed zone (this runtime lists `Asia/Calcutta`,
    // a browser elsewhere may have saved `Asia/Kolkata`): the API accepts
    // both and the sandbox resolves both.
    const stored = "Asia/Kolkata";
    expect(Intl.supportedValuesOf("timeZone")).not.toContain(stored);
    render(
      <WorkspaceTimezoneCard workspaceId="ws-1" currentTimezone={stored} />,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent(stored);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("warns that a change restarts the workspace's agents", () => {
    render(<WorkspaceTimezoneCard workspaceId="ws-1" currentTimezone={null} />);
    expect(
      screen.getByText(/restarts every running agent in this workspace/),
    ).toBeInTheDocument();
  });

  it("submits the chosen zone once, then treats it as the saved value", async () => {
    // Radix Select renders its listbox in a portal; click through it the
    // way a person does (the pointer APIs are stubbed above).
    const user = userEvent.setup();
    render(<WorkspaceTimezoneCard workspaceId="ws-1" currentTimezone={null} />);
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Asia/Tokyo" }));
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();

    await user.click(save);
    expect(state.calls).toEqual([{ id: "ws-1", timezone: "Asia/Tokyo" }]);
    // The server now holds Asia/Tokyo: nothing left to save, no second
    // respawn on a re-click.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});
