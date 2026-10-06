import {
  MAX_AGENT_CONNECTION_API_HOST_CHARS,
  MAX_AGENT_CONNECTION_API_HOSTS,
  MAX_AGENT_CONNECTION_DOCS_URL_CHARS,
  MAX_AGENT_CONNECTION_ENDPOINT_CHARS,
  MAX_AGENT_CONNECTION_ENDPOINTS,
  type AgentConnectionWire,
} from "@onecli/agent-protocol";
import { getApp } from "../apps/registry";
import {
  allGroupTools,
  getAppPermissionDefinition,
  hostPatternsOf,
} from "../apps/app-permissions";
import type { AppTool } from "../apps/app-permissions/types";

/**
 * The catalog half of a connected app, for the agent's "Connected apps"
 * block: the API hosts it should call, a few sample endpoints, and the
 * provider's API docs. `agent-connections-render.ts` supplies WHICH apps
 * (the injection law) and the tenant host; this supplies WHERE and HOW.
 *
 * Why: the bound host covers only tenant-bound apps (Salesforce, Snowflake,
 * JFrog). For every other app the agent still had to guess, and the obvious
 * guess is often wrong: Granola's desktop API `api.granola.ai` answers
 * "Unsupported client" while the public one is `public-api.granola.ai`. An
 * agent holding a live Granola grant told its owner, twice, that Granola
 * "isn't connected".
 *
 * Pure and catalog-only (no DB, no credentials): everything here is already
 * public in the permission catalog the gateway enforces. Every rule below is
 * provider-agnostic, derived from the catalog's shape; a new kind of fact
 * follows `apiDocsUrl`'s path (app definition → wire schema → here → the
 * supervisor's `catalogSuffix`) rather than per-provider text.
 */

/**
 * The HTTP method a sample should name. A GraphQL-discriminated tool is
 * POST by the protocol even when the catalog row carries no method (Linear's
 * rows are `graphqlOps` only); any other method-less tool (an MCP endpoint,
 * a wildcard umbrella) has no single method to show, so it yields none.
 */
const sampleMethodOf = (tool: AppTool): string | null => {
  const declared = tool.methods?.[0] ?? tool.method;
  if (declared) return declared.toUpperCase();
  return tool.graphqlOps ? "POST" : null;
};

/**
 * A path an agent can take as a template: not the bare root or a catch-all,
 * and not one that opens with a wildcard segment (GitHub's
 * `<owner>/<repo>/git-upload-pack` is git's smart-HTTP transport, not an API
 * call to type into curl).
 */
const isSamplePath = (path: string): boolean =>
  path !== "/" && path !== "*" && !path.startsWith("/*");

/**
 * Fixed hosts only: a `*.zone` pattern is not callable, and a tenant app's
 * one callable host is the bound `host` the caller already has. All or
 * nothing: a credential spanning more fixed hosts than the wire carries (AWS
 * answers on dozens of service hosts) gets none rather than an arbitrary
 * two, since a listed host is read as THE host to call.
 */
const fixedApiHosts = (provider: string): string[] => {
  const def = getAppPermissionDefinition(provider);
  if (!def) return [];
  const hosts = new Set<string>();
  for (const group of def.groups) {
    for (const tool of allGroupTools(group)) {
      for (const pattern of hostPatternsOf(tool)) {
        if (
          !pattern.includes("*") &&
          pattern.length <= MAX_AGENT_CONNECTION_API_HOST_CHARS
        ) {
          hosts.add(pattern);
        }
      }
    }
  }
  return hosts.size <= MAX_AGENT_CONNECTION_API_HOSTS ? [...hosts] : [];
};

/** Read tools first (the safest, most common first call), then writes. */
const endpointSamples = (provider: string): string[] => {
  const def = getAppPermissionDefinition(provider);
  if (!def) return [];
  const ordered = [
    ...def.groups.filter((g) => g.category === "read"),
    ...def.groups.filter((g) => g.category !== "read"),
  ];
  const out: string[] = [];
  for (const group of ordered) {
    for (const tool of group.tools) {
      const method = sampleMethodOf(tool);
      if (!method || !isSamplePath(tool.pathPattern)) continue;
      const line = `${method} ${tool.pathPattern}`;
      if (line.length > MAX_AGENT_CONNECTION_ENDPOINT_CHARS) continue;
      if (out.includes(line)) continue;
      out.push(line);
      if (out.length >= MAX_AGENT_CONNECTION_ENDPOINTS) return out;
    }
  }
  return out;
};

const safeDocsUrl = (raw: string | undefined): string | null => {
  if (!raw || raw.length > MAX_AGENT_CONNECTION_DOCS_URL_CHARS) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
};

/** The catalog facts for one provider. Unknown providers get empty facts. */
export const catalogFactsFor = (
  provider: string,
): Pick<AgentConnectionWire, "apiHosts" | "endpoints" | "docsUrl"> => ({
  apiHosts: fixedApiHosts(provider),
  endpoints: endpointSamples(provider),
  docsUrl: safeDocsUrl(getApp(provider)?.apiDocsUrl),
});
