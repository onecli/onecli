// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContactRowFrame } from "./contact-row-frame";

/**
 * The one row shape. Acceptance behaviors: a row with nothing more to
 * offer renders no menu but keeps the column; actions come first and
 * Remove last, separated, destructive-styled; Remove only calls back (the
 * caller owns the confirm); the label is an identifier (translate="no").
 */
describe("ContactRowFrame", () => {
  it("no actions and no remove: no menu, column preserved", () => {
    render(
      <ContactRowFrame
        label="Workspace members"
        status={<span>Allowed</span>}
      />,
    );
    expect(screen.queryByRole("button", { name: /More for/ })).toBeNull();
    expect(
      screen.getByText("Workspace members").getAttribute("translate"),
    ).toBe("no");
  });

  it("actions first, Remove last and destructive; Remove only calls back", async () => {
    const view = vi.fn();
    const remove = vi.fn();
    render(
      <ContactRowFrame
        label="Ray"
        status={<span>Allowed</span>}
        actions={[{ label: "View conversation", icon: null, onSelect: view }]}
        onRemove={remove}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["View conversation", "Remove"]);
    expect(
      screen
        .getByRole("menuitem", { name: "Remove" })
        .getAttribute("data-variant"),
    ).toBe("destructive");
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(view).not.toHaveBeenCalled();
  });

  it("a disabled action stays in the menu (keyboard walk keeps its shape) but does not fire", async () => {
    const view = vi.fn();
    render(
      <ContactRowFrame
        label="Ray"
        status={<span>Asks first</span>}
        actions={[
          {
            label: "View conversation",
            icon: null,
            onSelect: view,
            disabled: true,
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    const item = screen.getByRole("menuitem", { name: "View conversation" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(item);
    expect(view).not.toHaveBeenCalled();
  });
});
