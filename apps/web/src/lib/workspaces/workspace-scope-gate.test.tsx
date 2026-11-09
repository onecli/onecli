// @vitest-environment jsdom
import { useInsertionEffect } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceId } from "@/lib/api-fetch";
import { WorkspaceScopeGate } from "./workspace-scope-gate";

/**
 * A client-side switch into another workspace renders the new pages before
 * Next writes the new URL (its history update is an insertion effect of the
 * same commit). The pages key their reads to the URL, so a render in that
 * gap reads the workspace being left. These tests replay the race: a
 * sibling stands in for Next's history update, and the page records which
 * workspace it saw on every render.
 */

const NextHistoryUpdate = ({ to }: { to: string }) => {
  useInsertionEffect(() => {
    window.history.replaceState(null, "", to);
  }, [to]);
  return null;
};

const seen: (string | undefined)[] = [];
const Page = () => {
  seen.push(getWorkspaceId());
  return <p>page</p>;
};

afterEach(() => {
  cleanup();
  seen.length = 0;
  window.history.replaceState(null, "", "/");
});

describe("WorkspaceScopeGate", () => {
  it("never lets the page read the workspace being left", () => {
    window.history.replaceState(null, "", "/w/old/agents/a1/chat");
    const { getByText } = render(
      <>
        <NextHistoryUpdate to="/w/new/agents/a2/chat" />
        <WorkspaceScopeGate workspaceId="new">
          <Page />
        </WorkspaceScopeGate>
      </>,
    );
    expect(getByText("page")).toBeInTheDocument();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ws) => ws === "new")).toBe(true);
  });

  it("is the gate that does it: ungated, the page reads the old workspace", () => {
    window.history.replaceState(null, "", "/w/old/agents/a1/chat");
    render(
      <>
        <NextHistoryUpdate to="/w/new/agents/a2/chat" />
        <Page />
      </>,
    );
    expect(seen[0]).toBe("old");
  });

  it("passes straight through when the URL already names the workspace", () => {
    window.history.replaceState(null, "", "/w/ws1/agents/a1/chat");
    render(
      <WorkspaceScopeGate workspaceId="ws1">
        <Page />
      </WorkspaceScopeGate>,
    );
    expect(seen).toEqual(["ws1"]);
  });

  it("still draws the page if the URL never names the workspace", () => {
    window.history.replaceState(null, "", "/org/o1/workspaces");
    const { getByText } = render(
      <WorkspaceScopeGate workspaceId="ws1">
        <Page />
      </WorkspaceScopeGate>,
    );
    expect(getByText("page")).toBeInTheDocument();
  });
});
