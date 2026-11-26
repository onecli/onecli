import {
  defaultOtherReads,
  type AppPermissionDefinitionSummary,
} from "@onecli/api/apps/app-permissions/types";
import type { AgentGrantConnection } from "./types";

/** The access fields of a grant: what a switch-on writes. */
export type GrantAccess = Pick<
  AgentGrantConnection,
  "access" | "allow" | "ask" | "otherReads" | "otherWrites"
>;

/**
 * What turning a connection on grants, as the agent page will read it back:
 * the client twin of the server's `defaultConnectionGrant` (grants-compile),
 * computed from the public catalog summary the page already loads. Read
 * tools allowed (other reads too, for a catalog checked safe), write tools
 * and other writes needing approval; an app with no tool list keeps full
 * access.
 *
 * Only a placeholder: the instant answer to a click until the server's grant
 * arrives (the PUT returns it) and replaces it. Its drift test pins it to the
 * server function for every catalog, so the placeholder never disagrees with
 * what lands. Kept here, not imported from the server module: that one pulls
 * in the endpoint mapping, which must never reach the browser bundle.
 */
export const defaultGrantAccess = (
  catalog: AppPermissionDefinitionSummary | undefined,
): GrantAccess => {
  const groups = catalog?.groups ?? [];
  const toolsOf = (category: "read" | "write") =>
    groups
      .filter((g) => g.category === category)
      .flatMap((g) => g.tools.map((t) => t.id))
      .sort();
  const ask = toolsOf("write");
  // Write wins: a tool listed under both is held for approval.
  const allow = toolsOf("read").filter((id) => !ask.includes(id));
  if (allow.length + ask.length === 0) {
    return {
      access: "full",
      allow: [],
      ask: [],
      otherReads: "allow",
      otherWrites: "allow",
    };
  }
  return {
    access: "custom",
    allow,
    ask,
    otherReads: defaultOtherReads(catalog),
    otherWrites: "ask",
  };
};

/**
 * The consent line's access half: what switching an account on grants, in
 * words. Derived from `defaultGrantAccess` (pinned to the server by its drift
 * test), so a connect door can never promise less approval than lands.
 */
export const defaultGrantConsent = (
  catalog: AppPermissionDefinitionSummary | undefined,
): string => {
  const access = defaultGrantAccess(catalog);
  if (access.access === "full") return "It gets full access.";
  // "Reads that could expose secrets" are reads outside the tool list. An
  // exhaustive catalog (PostgreSQL) has none, so only writes are held.
  return access.otherReads === "allow" || catalog?.exhaustive
    ? "Writes need your approval."
    : "Writes, and reads that could expose secrets, need your approval.";
};

/** The same half for a door that cannot know the app yet (the app picker):
 * the strictest case, plus the one exception. */
export const ANY_APP_GRANT_CONSENT =
  "Writes, and reads that could expose secrets, need your approval (an app with no tool list gets full access).";

/** The half for a door offering several apps at once (the chat card): their
 * shared sentence when every app lands the same default, otherwise the
 * any-app line, so no app is promised less approval than it gets. */
export const defaultGrantConsentForAll = (
  catalogs: (AppPermissionDefinitionSummary | undefined)[],
): string => {
  const [only, ...rest] = new Set(catalogs.map(defaultGrantConsent));
  return only !== undefined && rest.length === 0 ? only : ANY_APP_GRANT_CONSENT;
};
