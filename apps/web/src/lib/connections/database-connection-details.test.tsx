// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatabaseConnectionDetails } from "./database-connection-details";

describe("DatabaseConnectionDetails", () => {
  it.each([
    [["TLS verified"], "Certificate verification on"],
    [["TLS"], "Certificate verification off"],
  ])("explains saved encryption settings %j without a badge", (tags, label) => {
    const { container } = render(<DatabaseConnectionDetails tags={tags} />);
    expect(screen.getByText(label, { exact: false }).textContent).toContain(
      "Encrypted",
    );
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
    expect(screen.queryByText("Connection verified")).toBeNull();
    expect(screen.queryByText(/Not encrypted/)).toBeNull();
  });

  it("warns on a connection without encryption", () => {
    render(<DatabaseConnectionDetails tags={["No TLS"]} />);
    expect(
      screen.getByLabelText("Database encryption settings").textContent,
    ).toContain("Not encrypted");
    expect(screen.queryByText(/^Encrypted/)).toBeNull();
  });

  it("does not invent TLS settings when metadata is unavailable", () => {
    render(
      <DatabaseConnectionDetails tags={[]}>
        <button>Test connection</button>
      </DatabaseConnectionDetails>,
    );
    expect(screen.queryByLabelText("Database encryption settings")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).not.toBeNull();
  });
});
