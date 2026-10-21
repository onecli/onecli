// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LocalRequestAppSlot,
  appRequestIssueUrl,
} from "./request-app-slot-local";

/** Self-host "Request an app" is a GitHub issue link, pre-filled with the
 * app the user searched for, like the cloud dialog. */

const titleOf = (href: string | null) =>
  new URL(href ?? "").searchParams.get("title");

describe("LocalRequestAppSlot", () => {
  it("puts the searched app name in the issue title", () => {
    render(<LocalRequestAppSlot initialName="  Notion " />);
    const link = screen.getByRole("link", { name: /Request an app/ });
    expect(titleOf(link.getAttribute("href"))).toBe("App request: Notion");
  });

  it("leaves the title open without a search", () => {
    expect(titleOf(appRequestIssueUrl())).toBe("App request: ");
  });

  it("keeps the label and template whatever the name", () => {
    const url = new URL(appRequestIssueUrl("a&labels=x"));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/onecli/onecli/issues/new",
    );
    expect(url.searchParams.getAll("labels")).toEqual(["app request"]);
    expect(url.searchParams.get("title")).toBe("App request: a&labels=x");
  });
});
