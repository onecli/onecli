import {
  allGroupTools,
  getAppPermissionDefinition,
  type AppTool,
} from "../../../apps/app-permissions";
import { endpointMatches } from "../endpoint-match";
import { hostMatches } from "../../../lib/path-match";
import type { OldCondition, PolicyRequest } from "../types";

/** Look up a catalog tool by (provider, toolId) — mirrors resolvePermissionChanges. */
export const getAppTool = (
  provider: string,
  toolId: string,
): AppTool | undefined => {
  const def = getAppPermissionDefinition(provider);
  if (!def) return undefined;
  for (const group of def.groups) {
    for (const tool of allGroupTools(group)) {
      if (tool.id === toolId) return tool;
    }
  }
  return undefined;
};

export interface RuleVariant {
  pathPattern: string;
  method: string | null;
}

/**
 * Port of `policy-rule-service.ts::allRuleVariants` — the paths×methods a tool
 * fans into. The gateway evaluates the stored rows; the new engine re-expands
 * via the catalog. The translator only emits an app-target when a group's stored
 * variants EXACTLY equal this expansion (translate/app-permission.ts), so the
 * re-expansion is always faithful; any drift falls back to verbatim network
 * rules. Also used by the corpus tests to generate catalog-consistent rows.
 */
export const allRuleVariants = (tool: AppTool): RuleVariant[] => {
  const paths = [tool.pathPattern, ...(tool.aliasPatterns ?? [])];
  const methods: (string | null)[] = tool.methods ?? [tool.method ?? null];
  return paths.flatMap((p) =>
    methods.map((m) => ({ pathPattern: p, method: m })),
  );
};

/**
 * Does `request` hit any tool in an app target? A tool matches when the request
 * host matches the tool's host and any of its path×method variants matches
 * (subject to the rule's conditions). An unknown toolId matches nothing.
 */
export const appTargetMatches = (
  request: PolicyRequest,
  provider: string,
  toolIds: string[],
  conditions: OldCondition[] | null,
): boolean =>
  toolIds.some((toolId) => {
    const tool = getAppTool(provider, toolId);
    if (!tool) return false;
    if (!hostMatches(request.host, tool.hostPattern)) return false;
    return allRuleVariants(tool).some((v) =>
      endpointMatches(request, {
        pathPattern: v.pathPattern,
        method: v.method,
        conditions,
      }),
    );
  });

/**
 * Does `host` match ANY catalog tool host of `provider`? The WHOLE-app match
 * behind a tool-LESS app target (the dialog's "All connections" and an
 * empty-tools resolved `connection` target): host-only — any path/method,
 * conditions ignored — the exact `secret`-target mirror
 * (`catalog.rs::app_target_matches`, empty-tools branch). A tool-narrowed
 * target runs the per-tool fan-out instead (`appTargetMatches`). A
 * catalog-less/unknown provider matches nothing (fail-safe: the permit surface
 * can never exceed the catalog).
 */
export const providerHostMatches = (
  host: string,
  provider: string,
): boolean => {
  const def = getAppPermissionDefinition(provider);
  if (!def) return false;
  return def.groups.some((group) =>
    allGroupTools(group).some((tool) => hostMatches(host, tool.hostPattern)),
  );
};
