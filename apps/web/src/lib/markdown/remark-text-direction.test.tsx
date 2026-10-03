// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/chat/_components/chat-markdown";

/**
 * Hebrew answers read right-to-left. These tests pin remark-text-direction
 * through the real renderer: the root and each block get a `dir`, one list
 * keeps all its markers on one side (even with an all-English bullet),
 * English-only paragraphs and code stay LTR, and the attribute is the ONLY
 * thing added (the XSS posture of chat-markdown.test.tsx is untouched).
 */
describe("remarkTextDirection via ChatMarkdown", () => {
  const HEBREW_ANSWER = [
    "**איך מתחברים ל-Cloudflare - 3 שלבים:**",
    "",
    "- לוחצים **Create Token** ובוחרים תבנית",
    "- Dev: אף אחד מ-4 פריטי התוכנית לא נסגר השבוע",
    "- Account → Workers Scripts → Edit",
    "",
    "Account → Workers Scripts → Edit",
    "",
    "```",
    "Invalid access token",
    "```",
  ].join("\n");

  it("renders a Hebrew answer RTL, keeping English-only paragraphs and code LTR", () => {
    const { container } = render(<ChatMarkdown text={HEBREW_ANSWER} />);
    expect(container.firstElementChild).toHaveAttribute("dir", "rtl");
    const paragraphs = [...container.querySelectorAll(":scope > div > p")];
    expect(paragraphs.map((p) => p.getAttribute("dir"))).toEqual([
      "rtl",
      "ltr",
    ]);
    expect(container.querySelector("pre")).toHaveAttribute("dir", "ltr");
  });

  it("puts direction on the list, never on its items", () => {
    const { container } = render(<ChatMarkdown text={HEBREW_ANSWER} />);
    expect(container.querySelector("ul")).toHaveAttribute("dir", "rtl");
    for (const li of container.querySelectorAll("li")) {
      expect(li).not.toHaveAttribute("dir");
    }
  });

  it("lets a paragraph inside a list or quote follow its container", () => {
    // A loose list wraps each item's text in a <p>; a quote always does.
    // Those inner paragraphs must not re-vote, or one English bullet would
    // sit on the other side of its own marker.
    const { container } = render(
      <ChatMarkdown
        text={[
          "- שלב ראשון: פותחים את ההגדרות של החשבון",
          "",
          "- Account → Workers Scripts",
          "",
          "> Account → Workers Scripts → Edit",
        ].join("\n")}
      />,
    );
    for (const p of container.querySelectorAll("li p, blockquote p")) {
      expect(p).not.toHaveAttribute("dir");
    }
    expect(container.querySelector("ul")).toHaveAttribute("dir", "rtl");
    expect(container.querySelector("blockquote")).toHaveAttribute("dir", "ltr");
  });

  it("directs headings, quotes and tables block by block", () => {
    const { container } = render(
      <ChatMarkdown
        text={[
          "## סיכום השבוע",
          "",
          "> ציטוט בעברית",
          "",
          "| מדד | Value |",
          "| - | - |",
          "| הכנסות | 1,200 USD |",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("h2")).toHaveAttribute("dir", "rtl");
    expect(container.querySelector("blockquote")).toHaveAttribute("dir", "rtl");
    expect(container.querySelector("table")).toHaveAttribute("dir", "rtl");
    const cells = [...container.querySelectorAll("th, td")];
    expect(cells.map((cell) => cell.getAttribute("dir"))).toEqual([
      "rtl",
      "ltr",
      "rtl",
      "ltr",
    ]);
  });

  it("lets a link's text vote but never its URL", () => {
    // The URL is pure LTR letters; if it voted, this one-word Hebrew line
    // would flip to LTR. A bare URL is autolinked by GFM with the URL as
    // its text, so the token filter (not the node type) keeps it out.
    const { container } = render(
      <ChatMarkdown
        text={[
          "[תיעוד](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)",
          "",
          "פותחים https://app.onecli.sh/w/abc/connections?connect=cloudflare&source=agent",
        ].join("\n")}
      />,
    );
    for (const p of container.querySelectorAll("p")) {
      expect(p).toHaveAttribute("dir", "rtl");
    }
  });

  it("keeps inline code LTR inside a Hebrew line", () => {
    const { container } = render(
      <ChatMarkdown text={"מריצים `npm run deploy` ומחכים"} />,
    );
    expect(container.querySelector("p")).toHaveAttribute("dir", "rtl");
    expect(container.querySelector("code")).toHaveAttribute("dir", "ltr");
  });

  it("leaves an English answer LTR", () => {
    const { container } = render(
      <ChatMarkdown text={"Deployed.\n\n- one\n- two"} />,
    );
    expect(container.firstElementChild).toHaveAttribute("dir", "ltr");
    expect(container.querySelector("ul")).toHaveAttribute("dir", "ltr");
  });

  it("adds only a dir attribute: Hebrew with raw HTML still renders inert", () => {
    const { container } = render(
      <ChatMarkdown text={"שלום <img src=x onerror=alert(1)> עולם"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p")).toHaveAttribute("dir", "rtl");
  });
});
