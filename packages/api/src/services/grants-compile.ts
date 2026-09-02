import type { Prisma } from "@onecli/db";
import { catalogToolIds } from "../apps/app-permissions/validate";
import type { PolicyRuleRow } from "./policy-service";
import type { ConnectionGrantInput } from "../validations/grants";

/**
 * The PURE half of the step-2 grants compiler: desired-stack computation and
 * stack comparison, with no database access. `grants-service` re-imports
 * everything here; the two must never drift, so neither duplicates a rule
 * shape the other owns.
 */

/** Origin marker of every grant-compiled rule row (`source` column). */
export const GRANT_SOURCE = "grant";

/** One rule of a desired stack, before priorities/ids are assigned. */
export interface CompiledRule {
  name: string;
  action: "allow" | "block";
  requireApproval: boolean;
  /** Tool narrowing for the connection target; empty = the whole app. */
  tools: string[];
  /**
   * Session-policy conditions, carried on EVERY allow-action row of a stack —
   * not just the first: the gateway's session-policy assembly is last-match-
   * wins per matching allow row (`inject_select`), so a condition-less ask-row
   * after a conditioned allow-row would clobber the policy with "unrestricted".
   * Block rows never carry conditions (they are decision-only).
   */
  conditions?: Prisma.JsonValue | null;
}

export const sorted = (ids: string[]): string[] => [...ids].sort();

/** The §4.2 stack for one (agent, connection) grant. Order is load-bearing:
 * first-match walks allow → ask → blocked → everything-else.
 *
 * Allow-first is DELIBERATE, not an oversight, for overlapping catalog tools:
 * read tools overlap by design (google-calendar's `get_calendar` glob covers
 * `list_events`' endpoints; github's `get_repo` covers the list endpoints), so
 * a blocked-first walk would let a Never row eat an ALLOWED sibling's
 * endpoints and break tools the user explicitly enabled (caught by the pg
 * proof suite). The one security-critical overlap - GraphQL queries vs
 * mutations on one `POST /graphql` - is not solved by ordering at all but by
 * the fail-closed `graphqlOps` body discrimination: a mutation body never
 * matches the query tool's allow row, falls through, and dies on the blocked
 * or terminal row regardless of this ordering. */
export const compileConnectionStack = (
  nameBase: string,
  provider: string,
  input: ConnectionGrantInput,
  conditions: Prisma.JsonValue | null = null,
): CompiledRule[] => {
  if (input.access === "full") {
    return [
      {
        name: nameBase,
        action: "allow",
        requireApproval: false,
        tools: [],
        conditions,
      },
    ];
  }
  const allow = sorted(input.allow);
  const ask = sorted(input.ask);
  const chosen = new Set([...allow, ...ask]);
  const blocked = sorted(
    catalogToolIds(provider).filter((t) => !chosen.has(t)),
  );
  const stack: CompiledRule[] = [];
  if (allow.length > 0) {
    stack.push({
      name: `${nameBase}: allowed`,
      action: "allow",
      requireApproval: false,
      tools: allow,
      conditions,
    });
  }
  if (ask.length > 0) {
    stack.push({
      name: `${nameBase}: needs approval`,
      action: "allow",
      requireApproval: true,
      tools: ask,
      conditions,
    });
  }
  if (blocked.length > 0) {
    stack.push({
      name: `${nameBase}: blocked`,
      action: "block",
      requireApproval: false,
      tools: blocked,
    });
  }
  // Terminal: the whole app surface — makes "deny" explicit rather than
  // default-dependent, and future catalog tools arrive as Never until enabled.
  stack.push({
    name: `${nameBase}: everything else`,
    action: "block",
    requireApproval: false,
    tools: [],
  });
  return stack;
};

/** The single-allow stack of a secret grant (`setSecretGrant`'s shape). */
export const compileSecretGrant = (nameBase: string): CompiledRule[] => [
  { name: nameBase, action: "allow", requireApproval: false, tools: [] },
];

/**
 * Semantic conditions equality across the storage forms: a DRAFT row without
 * conditions holds SQL NULL, while a PUBLISHED snapshot of it holds jsonb
 * `null` (`snapshotDraftRules` writes `Prisma.JsonNull`) — both mean "none".
 * Objects compare key-sorted, because Postgres jsonb does NOT preserve key
 * order: a round-tripped session policy would otherwise miscompare against
 * the freshly compiled one and defeat idempotence.
 */
export const conditionsEqual = (a: unknown, b: unknown): boolean =>
  canonicalJson(a) === canonicalJson(b);

const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(sortKeysDeep(value)) ?? "null";
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, nested]) => [key, sortKeysDeep(nested)]),
    );
  }
  return value;
};

/**
 * Draft-row write form of a stack row's conditions: omitted (SQL NULL) when
 * absent — matching every hand-authored draft row — and the single unknown →
 * InputJsonValue boundary cast when present (already-validated Zod output or
 * a value copied straight from the DB; the same law as `policy-service`'s
 * `jsonInput`).
 */
export const conditionsCreateInput = (
  conditions: Prisma.JsonValue | null | undefined,
): Prisma.InputJsonValue | undefined =>
  conditions == null ? undefined : (conditions as Prisma.InputJsonValue);

/** Semantic equality of an existing stack vs the desired one — names included
 * (a stale label after an agent/connection rename repairs on write). */
export const stackEquals = (
  existing: PolicyRuleRow[],
  desired: CompiledRule[],
): boolean =>
  existing.length === desired.length &&
  existing.every((row, i) => {
    const want = desired[i];
    return (
      want !== undefined &&
      row.enabled &&
      row.action === want.action &&
      row.requireApproval === want.requireApproval &&
      row.name === want.name &&
      conditionsEqual(row.conditions, want.conditions) &&
      sorted(row.targets[0]?.appTools ?? []).join("\n") ===
        want.tools.join("\n")
    );
  });

/** Fold one connection's stack rows back into the tri-state intent. */
export const stackToGrant = (
  rows: PolicyRuleRow[],
): { access: "full" | "custom"; allow: string[]; ask: string[] } => {
  const isFull =
    rows.length === 1 &&
    rows[0]?.action === "allow" &&
    !rows[0].requireApproval &&
    (rows[0].targets[0]?.appTools ?? []).length === 0;
  if (isFull) return { access: "full", allow: [], ask: [] };
  const allow = rows
    .filter((r) => r.action === "allow" && !r.requireApproval)
    .flatMap((r) => r.targets[0]?.appTools ?? []);
  const ask = rows
    .filter((r) => r.action === "allow" && r.requireApproval)
    .flatMap((r) => r.targets[0]?.appTools ?? []);
  return { access: "custom", allow: sorted(allow), ask: sorted(ask) };
};

/**
 * The session policy a stack carries, read back off its rows: the first
 * allow-action row's conditions (every allow row carries the same value by
 * construction — see `CompiledRule.conditions`). Pre-step-5 stacks never
 * carried one, so `null` is the common case.
 */
export const stackConditions = (
  rows: PolicyRuleRow[],
): Prisma.JsonValue | null =>
  rows.find((r) => r.action === "allow" && r.conditions !== null)?.conditions ??
  null;
