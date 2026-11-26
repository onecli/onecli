// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { guideHref, SetupGuideLink } from "./setup-guide-link";

describe("SetupGuideLink", () => {
  it("links the guide in a new tab with the shared wording", () => {
    render(
      <SetupGuideLink
        appName="Navan"
        url="https://onecli.sh/docs/integrations/navan"
      />,
    );
    const link = screen.getByRole("link", {
      name: /Follow the Navan setup guide/,
    });
    expect(link.getAttribute("href")).toBe(
      guideHref("https://onecli.sh/docs/integrations/navan"),
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders nothing without a url", () => {
    const { container } = render(<SetupGuideLink appName="Navan" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("guideHref", () => {
  const url = "https://onecli.sh/docs/integrations/linear";

  it("keeps the page top on Cloud", () => {
    expect(guideHref(url, true)).toBe(url);
  });

  it("jumps to the self-hosted section on self-hosted", () => {
    expect(guideHref(url, false)).toBe(`${url}#self-hosted`);
  });

  it("keeps an explicit anchor", () => {
    expect(guideHref(`${url}#scopes`, false)).toBe(`${url}#scopes`);
  });
});
