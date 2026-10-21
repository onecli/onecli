import type { AppPermissionDefinitionSummary } from "@onecli/api/apps/app-permissions/types";
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
 * tools allowed, write tools and every request outside the list needing
 * approval; an app with no tool list keeps full access.
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
    otherReads: "ask",
    otherWrites: "ask",
  };
};
