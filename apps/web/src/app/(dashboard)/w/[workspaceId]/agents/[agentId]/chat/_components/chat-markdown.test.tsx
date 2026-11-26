// @vitest-environment jsdom
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
    // The words stay, the address dies: no anchor carries a dangerous
    // protocol (here the link is dropped to its text entirely).
    expect(container.textContent).toContain("click me");
    for (const link of container.querySelectorAll("a")) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    }
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it("renders raw HTML img/event-handler payloads as text, not elements", () => {
    const { container } = render(
      <ChatMarkdown text={'<img src=x onerror="alert(1)">'} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  describe("hostile markdown, settled AND mid-stream", () => {
    // Streaming mode is new surface: the renderer COMPLETES open syntax
    // (remend), so a half-written payload is re-written before it parses.
    // Every vector runs both ways, and every prefix of it mid-stream, so a
    // completion can never mint a live element the settled text would not.
    const vectors = [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](  javascript:alert(1))",
      "[x](java\tscript:alert(1))",
      "[x](&#106;avascript:alert(1))",
      "[x](data:text/html;base64,PHNjcmlwdD4=)",
      "[x](vbscript:msgbox(1))",
      "![x](javascript:alert(1))",
      "![x](data:image/svg+xml;base64,PHN2Zz4=)",
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="https://evil.example"></iframe>',
      "<svg onload=alert(1)>",
      "<style>*{display:none}</style>",
      "[x][r]\n\n[r]: javascript:alert(1)",
      "<javascript:alert(1)>",
      "**[x](javascript:alert(1))**",
      "```html\n<script>alert(1)</script>",
    ];
    const LIVE = "script, iframe, svg, style, object, embed, form, input";
    const assertInert = (container: HTMLElement, label: string) => {
      // Our own chrome (the code block's copy icon is a lucide <svg>, marked
      // aria-hidden) is not model content; anything else live is.
      const live = [...container.querySelectorAll(LIVE)].filter(
        (el) => !el.closest("[data-slot='code-block'] button"),
      );
      expect(live, label).toHaveLength(0);
      for (const el of container.querySelectorAll("[href], [src]")) {
        const url = el.getAttribute("href") ?? el.getAttribute("src") ?? "";
        expect(url, label).not.toMatch(/^\s*(javascript|vbscript|data):/i);
      }
      for (const el of container.querySelectorAll("*")) {
        for (const attr of el.getAttributeNames()) {
          expect(attr.startsWith("on"), `${label} ${attr}`).toBe(false);
        }
      }
    };
    it.each(vectors)("stays inert: %s", (vector) => {
      for (const streaming of [false, true]) {
        const { container, unmount } = render(
          <ChatMarkdown text={vector} streaming={streaming} />,
        );
        assertInert(container, `${streaming ? "streaming" : "settled"}`);
        unmount();
      }
      // Every prefix, as the reveal would show it mid-stream.
      const { container, rerender } = render(
        <ChatMarkdown text="" streaming />,
      );
      for (let i = 1; i <= vector.length; i++) {
        rerender(<ChatMarkdown text={vector.slice(0, i)} streaming />);
        assertInert(container, `prefix ${i}`);
      }
    });
  });

  it("opens links in a new tab with rel=noopener noreferrer", () => {
    const { container } = render(
      <ChatMarkdown text={"[docs](https://example.com/guide)"} />,
    );
    const link = container.querySelector("a");
    expect(link).toHaveAttribute("href", "https://example.com/guide");
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

/**
 * The streaming renderer is a different library from the one these guards
 * were written against. These pin that its extras stay off and its defaults
 * never widen what model text can do.
 */
describe("ChatMarkdown streaming-renderer posture", () => {
  it("never renders a data: image (no inline payloads)", () => {
    const { container } = render(
      <ChatMarkdown text={"![x](data:image/png;base64,AAAA)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("data:image");
  });

  it("renders a half-written link as its words, never as a link", () => {
    const { container } = render(
      <ChatMarkdown text={"See [the docs](https://exa"} streaming />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("the docs");
    expect(container.innerHTML).not.toContain("streamdown:");
  });

  it("completes open syntax only while streaming", () => {
    const live = render(<ChatMarkdown text={"Hello **wor"} streaming />);
    expect(live.container.querySelector("strong")?.textContent).toBe("wor");
    // A settled answer is rendered exactly as written.
    const settled = render(<ChatMarkdown text={"Hello **wor"} />);
    expect(settled.container.querySelector("strong")).toBeNull();
  });

  it("has no link-safety modal, no copy/download controls of the library's", () => {
    const { container } = render(
      <ChatMarkdown
        text={"[docs](https://example.com/x)\n\n| a |\n| - |\n| 1 |"}
      />,
    );
    expect(container.querySelector("a")).toHaveAttribute(
      "href",
      "https://example.com/x",
    );
    expect(
      container.querySelector("[data-streamdown='table-wrapper']"),
    ).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("wraps words for the fade only while streaming, and never under reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const live = render(<ChatMarkdown text={"one two three"} streaming />);
    expect(
      live.container.querySelectorAll("[data-sd-animate]").length,
    ).toBeGreaterThan(0);
    const settled = render(<ChatMarkdown text={"one two three"} />);
    expect(
      settled.container.querySelectorAll("[data-sd-animate]"),
    ).toHaveLength(0);

    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const reduced = render(<ChatMarkdown text={"one two three"} streaming />);
    expect(
      reduced.container.querySelectorAll("[data-sd-animate]"),
    ).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("gives a code block its own copy button, copying exactly the code", async () => {
    // Before the stub: setup() installs a clipboard of its own.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(
      <ChatMarkdown text={"```sh\nnpm run build\n```"} />,
    );
    expect(container.querySelector("[data-slot='code-block']")).not.toBeNull();
    const button = container.querySelector("button")!;
    expect(button).toHaveAttribute("aria-label", "Copy code");
    expect(container.querySelector("pre code")?.textContent).toBe(
      "npm run build",
    );
    await user.click(button);
    // No trailing newline from the fence: a paste runs nothing by itself.
    expect(writeText).toHaveBeenCalledWith("npm run build");
    expect(button).toHaveAttribute("aria-label", "Copied");
  });
});
