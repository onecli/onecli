import {
  findGitHubOrgAccess,
  type GitHubOrgAccessIssue,
} from "@onecli/api/lib/github-org-access";
import type { Connection } from "@/lib/api/types";
import type { ConnectSuggestion } from "./connect-links";

/**
 * What one row of the chat's connect card says about one app, decided for
 * THIS agent (a pure decision, the lib/chat rule).
 *
 * Since a new connection stopped being on for every agent, "the
 * workspace has a Gmail account" and "this agent can use Gmail" are two
 * different facts. The row reads the second: an account the workspace holds
 * but this agent does not is `not_attached` (the fix is Attach), never
 * "Connected". Only an account this agent holds, through a workspace grant
 * or an organization rule, makes the row `attached`.
 *
 * - `org_access`: one GitHub organization refused the account (the
 *   gateway's `github_org_access_required`); the fix is per organization.
 * - `needs_reconnect`: the provider refused the saved login. A reconnect
 *   link names the account; otherwise it is every account this agent holds.
 * - `connect`: no connected account of this app in the workspace at all.
 * - `unknown`: what this agent holds has not resolved (`failed`: it could
 *   not be read). Neither "attached" nor "not attached" may be claimed,
 *   and neither may "nothing connected" while the pool itself is unknown.
 * - `not_attached`: accounts exist; this agent holds none of them.
 * - `attached`: this agent holds `connections` (status-connected, the pool
 *   the attach dialog lists), `primary` first: the account the row names.
 */
export type ConnectRowState =
  | { type: "org_access"; connection: Connection; issue: GitHubOrgAccessIssue }
  | { type: "needs_reconnect"; connection: Connection }
  | { type: "connect" }
  | { type: "unknown"; failed: boolean }
  | { type: "not_attached" }
  | {
      type: "attached";
      primary: Connection;
      connections: Connection[];
    };

/** A query's answer, or why there is none yet. `T` is an object so the
 * string arms can never collide with an answer (narrowed by `typeof`). */
export type Known<T extends object> = T | "pending" | "failed";

const unknown = (why: "pending" | "failed"): ConnectRowState => ({
  type: "unknown",
  failed: why === "failed",
});

export const resolveConnectRow = ({
  provider,
  kind,
  connectionId,
  org,
  connections,
  heldConnectionIds,
}: {
  provider: string;
  kind: ConnectSuggestion["kind"];
  /** The account a reconnect link names (`reconnect` only). */
  connectionId?: string;
  /** The organization an org-access link names (`org_access` only). */
  org?: string;
  /** The workspace's connections list, as the dashboard reads it. */
  connections: Known<readonly Connection[]>;
  /** The connections THIS agent holds (workspace grants plus org-rule
   * grants). */
  heldConnectionIds: Known<ReadonlySet<string>>;
}): ConnectRowState => {
  // An unread pool must not read as an empty one: "Connect" for an app the
  // agent already holds is the same false claim in the other direction.
  if (typeof connections === "string") return unknown(connections);
  const pool = connections.filter(
    (c) => c.provider === provider && c.status === "connected",
  );

  // Read live, not from the answer: once the gateway clears the record (a
  // reconnect, or the refused request went through), the row falls back to
  // the agent's normal state below.
  if (kind === "org_access" && org) {
    const access = findGitHubOrgAccess(
      pool.filter((c) => !c.reauthRequiredAt),
      org,
    );
    if (access) return { type: "org_access", ...access };
  }

  // A reconnect link names the dead account: act on THAT one. It clears on
  // its own once the reconnect lands (the list refetches).
  if (kind === "reconnect") {
    const named = pool.find((c) => c.id === connectionId);
    if (named?.reauthRequiredAt) {
      return { type: "needs_reconnect", connection: named };
    }
  }

  if (pool.length === 0) return { type: "connect" };
  if (typeof heldConnectionIds === "string") return unknown(heldConnectionIds);

  const held = pool.filter((c) => heldConnectionIds.has(c.id));
  // Healthy accounts first: the row names one this agent can use today.
  const ordered = [
    ...held.filter((c) => !c.reauthRequiredAt),
    ...held.filter((c) => c.reauthRequiredAt),
  ];
  const [primary] = ordered;
  if (primary === undefined) return { type: "not_attached" };

  // Every account this agent holds is refused: nothing works until one is
  // re-authorized. Not on an attach row: there the gateway said this agent
  // lacks a grant, and its count is the answer to that.
  if (kind !== "attach" && primary.reauthRequiredAt) {
    return { type: "needs_reconnect", connection: primary };
  }
  return { type: "attached", primary, connections: ordered };
};
