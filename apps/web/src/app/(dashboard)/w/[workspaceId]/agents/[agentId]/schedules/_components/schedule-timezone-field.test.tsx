// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleTimezoneField } from "./schedule-timezone-field";

/** The field as a schedule dialog holds it: the value is the parent's. */
const Harness = ({ initial }: { initial: string }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ScheduleTimezoneField id="tz" value={value} onChange={setValue} />
      <output aria-label="Saved zone">{value}</output>
    </>
  );
};

beforeEach(() => {
  // The list scrolls its active option into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("ScheduleTimezoneField", () => {
  it("picks with the keyboard alone: search, arrows, Enter", async () => {
    const user = userEvent.setup();
    render(<Harness initial="UTC" />);
    await user.click(screen.getByLabelText("Timezone"));
    const search = screen.getByRole("combobox", { name: "Search timezones" });
    expect(search).toHaveFocus();

    // Several matches, so each key lands somewhere different.
    await user.type(search, "america/n");
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(2);
    expect(search).toHaveAttribute("aria-activedescendant", options[0]?.id);
    await user.keyboard("{End}");
    expect(search).toHaveAttribute("aria-activedescendant", options.at(-1)?.id);
    await user.keyboard("{Home}{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", options[1]?.id);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByLabelText("Saved zone")).toHaveTextContent(
      options[0]?.textContent?.replace(/ /g, "_") ?? "",
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves down from the current zone, and keeps a zone the browser lacks", async () => {
    const user = userEvent.setup();
    render(<Harness initial="Mars/Olympus_Mons" />);
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(
      "Mars/Olympus Mons",
    );
    await user.click(screen.getByLabelText("Timezone"));
    const options = screen.getAllByRole("option");
    // The stored zone is listed first, selected, and is where arrows start.
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(screen.getByLabelText("Saved zone")).toHaveTextContent(
      "Mars/Olympus_Mons",
    );
  });
});
