// @vitest-environment jsdom
import {
  Activity,
  StrictMode,
  Suspense,
  use,
  useEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePortalHost } from "./use-portal-host";

/**
 * One node per mount, whatever React does to the subtree around it: a
 * Suspense fallback or a hidden Activity re-runs layout effects and refs on
 * reveal, and neither may produce a second node or remount the content.
 */

const HOST_CLASS = "portal-host";
const contentMounts = vi.fn();

const Content = () => {
  useEffect(() => {
    contentMounts();
  }, []);
  return <input aria-label="Draft" />;
};

const Section = () => {
  const { host, home } = usePortalHost(HOST_CLASS);
  return (
    <>
      <div data-testid="home" ref={home} />
      {host && createPortal(<Content />, host)}
    </>
  );
};

const homeChildren = () => [...screen.getByTestId("home").children];
/** The one node the hook made, wherever it is now. */
const theNode = () => {
  const node = document.querySelector(`.${HOST_CLASS}`);
  if (!node) throw new Error("The hook made no node");
  return node;
};
const typeDraft = () => {
  const draft = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Draft",
  });
  draft.value = "kept";
  return draft;
};

describe("usePortalHost", () => {
  it("puts its one node in the home element", () => {
    contentMounts.mockClear();
    render(<Section />);
    expect(homeChildren()).toHaveLength(1);
    expect(homeChildren()[0]).toHaveClass(HOST_CLASS);
    expect(homeChildren()[0]).toContainElement(
      screen.getByRole("textbox", { name: "Draft" }),
    );
    expect(contentMounts).toHaveBeenCalledTimes(1);
  });

  it("makes one node under StrictMode's double effects", () => {
    render(
      <StrictMode>
        <Section />
      </StrictMode>,
    );
    expect(homeChildren()).toHaveLength(1);
    expect(document.querySelectorAll(`.${HOST_CLASS}`)).toHaveLength(1);
  });

  it("keeps the node and its content through a Suspense hide and reveal", async () => {
    contentMounts.mockClear();
    const gate: { promise: Promise<void> | null } = { promise: null };
    const Suspends = () => {
      if (gate.promise) use(gate.promise);
      return null;
    };
    const tree = (): ReactNode => (
      <Suspense fallback={<p>Loading</p>}>
        <Section />
        <Suspends />
      </Suspense>
    );
    const { rerender } = render(tree());
    const node = homeChildren()[0];
    const draft = typeDraft();

    let resolve!: () => void;
    gate.promise = new Promise<void>((done) => (resolve = done));
    await act(async () => {
      rerender(tree());
    });
    expect(screen.getByText("Loading")).toBeInTheDocument();
    await act(async () => {
      gate.promise = null;
      resolve();
    });

    expect(screen.queryByText("Loading")).toBeNull();
    expect(homeChildren()).toEqual([node]);
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("kept");
    // A Suspense hide keeps passive effects: the content never remounted.
    expect(contentMounts).toHaveBeenCalledTimes(1);
  });

  it("keeps the node and its content through a hidden Activity", () => {
    const tree = (mode: "visible" | "hidden"): ReactNode => (
      <Activity mode={mode}>
        <Section />
      </Activity>
    );
    const { rerender } = render(tree("visible"));
    const node = homeChildren()[0];
    const draft = typeDraft();

    rerender(tree("hidden"));
    rerender(tree("visible"));

    expect(homeChildren()).toEqual([node]);
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("kept");
  });

  it("leaves the node where another owner moved it", () => {
    const away = document.createElement("aside");
    document.body.appendChild(away);
    const tree = (mode: "visible" | "hidden"): ReactNode => (
      <Activity mode={mode}>
        <Section />
      </Activity>
    );
    const { rerender } = render(tree("visible"));
    const node = theNode();

    away.appendChild(node);
    // A reveal re-attaches the home ref, which must not pull the node back.
    rerender(tree("hidden"));
    rerender(tree("visible"));

    expect(node.parentElement).toBe(away);
    expect(homeChildren()).toEqual([]);
    away.remove();
  });

  it("takes its node off the page on unmount", () => {
    const { unmount } = render(<Section />);
    const node = theNode();
    unmount();
    expect(node.isConnected).toBe(false);
  });
});
