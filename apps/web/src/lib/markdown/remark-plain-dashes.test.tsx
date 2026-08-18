// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/chat/_components/chat-markdown";

/**
 * House copy style: no em dashes in agent prose. The Slack adapter enforces
 * this in mrkdwn.ts; these tests pin the web transcript's counterpart
 * (remark-plain-dashes.ts) through the real renderer.
 */
describe("remarkPlainDashes via ChatMarkdown", () => {
  it("replaces em and en dashes with a plain hyphen", () => {
    const { container } = render(
      <ChatMarkdown text={"a policy block — not a glitch – really"} />,
    );
    expect(container.textContent).toBe(
      "a policy block - not a glitch - really",
    );
  });

  it("collapses a tight dash to a spaced hyphen", () => {
    const { container } = render(<ChatMarkdown text={"before—after"} />);
    expect(container.textContent).toBe("before - after");
  });

  it("collapses NBSP-flanked dashes and dash runs", () => {
    // Typographic prose flanks dashes with NBSP; a run of dashes is one
    // separator, not several.
    const { container } = render(
      <ChatMarkdown text={"a\u00a0—\u00a0b and c——d"} />,
    );
    expect(container.textContent).toBe("a - b and c - d");
  });

  it("leaves dashes in inline code and fences untouched", () => {
    const { container } = render(
      <ChatMarkdown text={"`a—b`\n\n```\nx — y\n```"} />,
    );
    expect(container.querySelector("code")?.textContent).toBe("a—b");
    expect(container.querySelector("pre")?.textContent).toContain("x — y");
  });

  it("never rewrites a dash inside a link URL", () => {
    const { container } = render(
      <ChatMarkdown text={"[docs](https://example.com/a—b)"} />,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toContain(
      `a${encodeURIComponent("—")}b`,
    );
  });
});
