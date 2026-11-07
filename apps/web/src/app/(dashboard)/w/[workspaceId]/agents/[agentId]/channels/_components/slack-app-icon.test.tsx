// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SlackAppIcon } from "./slack-app-icon";

/**
 * The attached card's face: the Slack app's OWN icon (never the agent's
 * image), with a pencil that deep-links to where Slack lets it be changed.
 */
const EDIT = "https://api.slack.com/apps/A1/general#display";
const ICON = "https://avatars.slack-edge.com/x_72.png";

const faceSrc = () =>
  screen.getByRole("link").querySelector("img")?.getAttribute("src");

describe("SlackAppIcon", () => {
  it("shows the app's real icon and links to Slack's Display Information", () => {
    render(<SlackAppIcon iconUrl={ICON} editUrl={EDIT} />);
    const link = screen.getByRole("link", {
      name: "Change the Slack app icon",
    });
    expect(link).toHaveAttribute("href", EDIT);
    expect(link).toHaveAttribute("target", "_blank");
    expect(faceSrc()).toBe(ICON);
  });

  it("falls back to the Slack logo while the app has no icon", () => {
    render(<SlackAppIcon iconUrl={null} editUrl={EDIT} />);
    expect(faceSrc()).not.toBe(ICON);
    expect(screen.getByRole("img", { name: "Slack" })).toBeInTheDocument();
  });

  it("falls back on a dead URL, and tries the next synced URL again", () => {
    const { rerender } = render(<SlackAppIcon iconUrl={ICON} editUrl={EDIT} />);
    fireEvent.error(screen.getByRole("link").querySelector("img")!);
    expect(screen.getByRole("img", { name: "Slack" })).toBeInTheDocument();

    const next = "https://avatars.slack-edge.com/y_72.png";
    rerender(<SlackAppIcon iconUrl={next} editUrl={EDIT} />);
    expect(faceSrc()).toBe(next);
  });
});
