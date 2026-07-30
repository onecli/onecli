import { ServiceError } from "../../services/errors";
import { getAppPermissionDefinition } from "./index";

/**
 * Validate that every tool id names a CONCRETE catalog tool of `provider`.
 *
 * Grants store per-tool tri-state as explicit tool-id lists; an id the catalog
 * doesn't know compiles into a rule that never matches anything (the engine's
 * fail-closed law: an unknown toolId matches nothing) — the silent-no-op class
 * this assert exists to reject loudly instead. Group wildcard ids are authoring
 * aliases of the rule form's picker, not grant inputs — the grant compiler
 * needs the concrete set to derive the blocked complement, so wildcards are
 * rejected here like any unknown id.
 *
 * A provider with no catalog has no per-tool axis at all — callers offer only
 * whole-app access there (mirroring the reflections' `catalog: false` honesty
 * arm), so any tool list for it is unprocessable.
 */
export const assertToolIdsValid = (
  provider: string,
  toolIds: string[],
): void => {
  if (toolIds.length === 0) return;
  const def = getAppPermissionDefinition(provider);
  if (!def) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Per-tool permissions need a permission catalog; "${provider}" has none.`,
    );
  }
  const known = new Set(def.groups.flatMap((g) => g.tools.map((t) => t.id)));
  const unknown = [...new Set(toolIds)].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Unknown tool id(s) for "${provider}": ${unknown.join(", ")}`,
    );
  }
};

/** The provider's full concrete tool-id set — the universe the grant
 * compiler derives the blocked complement from. Empty for a catalog-less
 * provider. */
export const catalogToolIds = (provider: string): string[] => {
  const def = getAppPermissionDefinition(provider);
  if (!def) return [];
  return def.groups.flatMap((g) => g.tools.map((t) => t.id));
};
