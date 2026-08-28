import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

/**
 * The agents key hierarchy's one structural law: `agents.root()` is the ONE
 * sweep that reaches every agents key — including `forWorkspace`, which sits
 * deliberately OUTSIDE the URL-derived scope() prefix (the sidebar reads it).
 * PR #845's bug class was invalidating `agents.all()` and assuming it covered
 * the sidebar; these tests pin both sides of that line.
 */

const startsWith = (
  key: readonly unknown[],
  prefix: readonly unknown[],
): boolean => prefix.every((part, i) => key[i] === part);

describe("queryKeys.agents.root()", () => {
  it("prefixes EVERY agents key — the sweep mutations rely on", () => {
    const root = queryKeys.agents.root();
    for (const key of [
      queryKeys.agents.all(),
      queryKeys.agents.list(),
      queryKeys.agents.detail("ag-1"),
      queryKeys.agents.models("ag-1"),
      queryKeys.agents.forWorkspace("ws-1"),
    ]) {
      expect(startsWith(key, root)).toBe(true);
      // A proper prefix — root() must stay broader than each concrete key.
      expect(key.length).toBeGreaterThan(root.length);
    }
  });

  it("is required because all() does NOT cover forWorkspace — the trap", () => {
    // The scoped sweep misses the sidebar's workspace-keyed list. If this
    // ever starts passing as a prefix, the deliberate split collapsed and
    // forWorkspace is back under the URL scope (see use-agents.ts on why it
    // must not be).
    expect(
      startsWith(queryKeys.agents.forWorkspace("ws-1"), queryKeys.agents.all()),
    ).toBe(false);
  });
});

describe("queryKeys.sshKeys", () => {
  it("is deliberately UNSCOPED — one cache across /account and /w pages", () => {
    // A scoped key would silently split the account manager and the agent
    // page's picker into two caches (see the rationale comment in keys.ts).
    expect(queryKeys.sshKeys.all()).toEqual(["ssh-keys"]);
    expect(queryKeys.sshKeys.list()).toEqual(["ssh-keys", "list"]);
  });
});
