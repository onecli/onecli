// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RepoScopePicker } from "./repo-scope-picker";

const repositories = Array.from({ length: 501 }, (_, i) =>
  i < 498 ? `acme/repo-${i}` : `acme/boundary-${i}`,
);

const LimitPicker = () => {
  const [picked, setPicked] = useState(
    () => new Set(repositories.slice(0, 499)),
  );
  return (
    <RepoScopePicker
      mode="selected"
      onModeChange={() => {}}
      repos={repositories}
      picked={picked}
      onPickedChange={setPicked}
    />
  );
};

describe("RepoScopePicker", () => {
  it("caps bulk selection at 500 and lets users deselect to make room", async () => {
    const user = userEvent.setup();
    render(<LimitPicker />);
    // Only the three boundary candidates remain in the DOM during assertions.
    // Keep a real 499-item selection so the production cap is exercised.
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search repositories" }),
      {
        target: { value: "boundary" },
      },
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Select all matches" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "boundary-499" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "boundary-500" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "boundary-498" }));
    expect(
      screen.getByRole("checkbox", { name: "boundary-500" }),
    ).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "boundary-500" }));
    expect(
      screen.getByRole("checkbox", { name: "boundary-500" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "boundary-498" }),
    ).toBeDisabled();
  });
});
