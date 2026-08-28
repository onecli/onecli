// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./chat-markdown";

/**
 * The stored-XSS guard. The transcript is untrusted, durable model output —
 * these tests pin the renderer's safety posture, and each one fails if the
 * config drifts (adding `rehype-raw`, overriding `urlTransform`, or swapping
 * the renderer for one that parses raw HTML).
 */
describe("ChatMarkdown safety", () => {
  it("renders a <script> in model output as inert text", () => {
    const { container } = render(
      <ChatMarkdown text={"before <script>alert(1)</script> after"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("never emits a javascript: href", () => {
    const { container } = render(
      <ChatMarkdown text={"[click me](javascript:alert(1))"} />,
    );
    // The anchor must exist (otherwise this assertion is vacuous) with its
    // dangerous protocol stripped by the default urlTransform.
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
  });

  it("renders raw HTML img/event-handler payloads as text, not elements", () => {
    const { container } = render(
      <ChatMarkdown text={'<img src=x onerror="alert(1)">'} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("opens links in a new tab with rel=noopener noreferrer", () => {
    const { container } = render(
      <ChatMarkdown text={"[docs](https://example.com)"} />,
    );
    const link = container.querySelector("a");
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("suppresses gateway connect links when asked — the chat card below the answer is the one call to action", () => {
    const { container } = render(
      <ChatMarkdown
        text={
          "Connect it here: https://app.onecli.sh/w/a/connections?connect=gmail&source=agent&agent_name=Arik"
        }
        suppressConnectLinks
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("connections?connect");
  });

  it("never suppresses a connect link the card will not render — unknown provider keeps its prose link", () => {
    // Suppression and the card must share one predicate: a provider this
    // build's catalog doesn't know renders no card, so deleting its link
    // would delete the user's only call to action.
    const { container } = render(
      <ChatMarkdown
        text={
          "Connect it here: https://app.onecli.sh/w/a/connections?connect=not-a-real-app-zzz"
        }
        suppressConnectLinks
      />,
    );
    expect(container.querySelector("a")).not.toBeNull();
  });

  it("keeps connect links as ordinary hardened links by default — surfaces with no card (memory sheet) must not lose them", () => {
    const { container } = render(
      <ChatMarkdown
        text={
          "Connect it here: https://app.onecli.sh/w/a/connections?connect=gmail"
        }
      />,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("ChatMarkdown rendering", () => {
  it("renders fenced code blocks", () => {
    const { container } = render(
      <ChatMarkdown text={"```js\nconst x = 1;\n```"} />,
    );
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("const x = 1;");
  });

  it("renders GFM tables", () => {
    const { container } = render(
      <ChatMarkdown text={"| a | b |\n| - | - |\n| 1 | 2 |"} />,
    );
    expect(container.querySelector("table")).not.toBeNull();
  });
});
