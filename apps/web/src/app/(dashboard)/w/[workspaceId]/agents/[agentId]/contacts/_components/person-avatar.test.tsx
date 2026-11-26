// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PersonAvatar } from "./person-avatar";

describe("PersonAvatar", () => {
  it("shows initials while there is no photo", () => {
    render(<PersonAvatar name="Alex Kim" imageUrl={null} />);
    expect(screen.getByText("AK")).toBeDefined();
  });

  it("a one-word name gives one initial; an empty one a ?", () => {
    const view = render(<PersonAvatar name="Dana" imageUrl={null} />);
    expect(screen.getByText("D")).toBeDefined();
    view.unmount();
    render(<PersonAvatar name="  " imageUrl={null} />);
    expect(screen.getByText("?")).toBeDefined();
  });
});
