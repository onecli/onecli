// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@onecli/ui/components/tooltip";
import type { OtherChoices } from "./grant-intent";
import { OtherRequestsSection } from "./other-requests-section";

// The "Not listed above" section: its own boxed section with an explanation,
// both catch-all rows, and no bulk dropdown.

const Harness = ({
  initial,
  unlisted,
  allToolsAllowed = false,
}: {
  initial: OtherChoices;
  unlisted?: "block";
  allToolsAllowed?: boolean;
}) => {
  const [other, setOther] = useState(initial);
  return (
    <TooltipProvider>
      <OtherRequestsSection
        other={other}
        unlisted={unlisted}
        allToolsAllowed={allToolsAllowed}
        readOnly={false}
        onChange={setOther}
      />
      <output data-testid="state">{`${other.otherReads}/${other.otherWrites}`}</output>
    </TooltipProvider>
  );
};

const pressedIn = (group: HTMLElement) =>
  within(group)
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-pressed") === "true")
    ?.getAttribute("aria-label");

const option = (row: string, label: string) =>
  within(screen.getByRole("group", { name: row })).getByRole("button", {
    name: label,
  });

describe("OtherRequestsSection", () => {
  it("is its own section, explains itself, and has no bulk dropdown", () => {
    render(<Harness initial={{ otherReads: "ask", otherWrites: "ask" }} />);
    const section = screen.getByRole("region", { name: "Not listed above" });
    expect(
      within(section).getByText(/including tools added later/),
    ).toBeTruthy();
    expect(within(section).queryByRole("combobox")).toBeNull();
    expect(pressedIn(screen.getByRole("group", { name: "Other reads" }))).toBe(
      "Needs approval",
    );
    expect(pressedIn(screen.getByRole("group", { name: "Other writes" }))).toBe(
      "Needs approval",
    );
  });

  it("sets each row on its own", async () => {
    render(<Harness initial={{ otherReads: "ask", otherWrites: "ask" }} />);
    await userEvent.click(option("Other reads", "Always allow"));
    expect(screen.getByTestId("state").textContent).toBe("allow/ask");
  });

  it("offers Always allow only once every tool is allowed when the app blocks unlisted requests (AWS)", async () => {
    render(
      <Harness
        initial={{ otherReads: "never", otherWrites: "never" }}
        unlisted="block"
      />,
    );
    expect(screen.getByText(/only as full access/)).toBeTruthy();
    for (const row of ["Other reads", "Other writes"]) {
      expect(option(row, "Always allow")).toHaveProperty("disabled", true);
      expect(option(row, "Needs approval")).toHaveProperty("disabled", false);
    }
    await userEvent.click(option("Other reads", "Needs approval"));
    expect(screen.getByTestId("state").textContent).toBe("ask/never");
  });

  it("moves both rows together through Always allow when the app blocks unlisted requests", async () => {
    render(
      <Harness
        initial={{ otherReads: "ask", otherWrites: "ask" }}
        unlisted="block"
        allToolsAllowed
      />,
    );
    // Always allow there IS full access, which covers both rows at once.
    await userEvent.click(option("Other reads", "Always allow"));
    expect(screen.getByTestId("state").textContent).toBe("allow/allow");
    // And leaving it on one row leaves it on both.
    await userEvent.click(option("Other writes", "Never"));
    expect(screen.getByTestId("state").textContent).toBe("never/never");
    // Below Always allow the rows stay independent.
    await userEvent.click(option("Other reads", "Needs approval"));
    expect(screen.getByTestId("state").textContent).toBe("ask/never");
  });
});
