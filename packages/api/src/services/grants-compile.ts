import type { Prisma } from "@onecli/db";
import { getAppPermissionDefinition } from "../apps/app-permissions";
import { methodsOf, type AppTool } from "../apps/app-permissions/types";
import {
  catalogBlocksUnlisted,
  catalogToolIds,
} from "../apps/app-permissions/validate";
import type { PolicyRuleRow } from "./policy-service";
import type {
  ConnectionGrantInput,
  UnlistedChoice,
} from "../validations/grants";

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
  /** A WHOLE-APP target's HTTP-method narrowing, stored as-is in the
   * target's `method` column: `GET,HEAD` (only reads) or `!GET,HEAD`
   * (everything but reads). Absent = any method, every row that predates
   * it. */
  method?: string;
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

/** A whole-app connection target's method narrowing, as stored in its
 * `method` column (the gateway's `MethodFilter`): `GET,HEAD` = only reads,
 * `!GET,HEAD` = everything but reads. */
const READS_ONLY = "GET,HEAD";
const ALL_BUT_READS = `!${READS_ONLY}`;

/** The default for both catch-alls: needs approval, or never for a catalog
 * that blocks unlisted requests (`unlisted: "block"`, AWS). */
const defaultUnlisted = (provider: string): UnlistedChoice =>
  catalogBlocksUnlisted(provider) ? "never" : "ask";

/**
 * What a new attach writes: read tools allowed, every write/delete tool and
 * every request outside the tool list needing approval (AWS included: Needs
 * approval is a valid catch-all there, only Always allow is not), so a fresh
 * connection never changes anything without a human saying yes. An app with
 * no catalog has no tool list to split on, so it keeps full access.
 */
export const defaultConnectionGrant = (
  provider: string,
): ConnectionGrantInput => {
  const groups = getAppPermissionDefinition(provider)?.groups ?? [];
  const toolsOf = (category: "read" | "write") =>
    sorted(
      groups
        .filter((g) => g.category === category)
        .flatMap((g) => g.tools.map((t) => t.id)),
    );
  const ask = toolsOf("write");
  // Write wins: a tool listed under both is held for approval.
  const allow = toolsOf("read").filter((t) => !ask.includes(t));
  if (allow.length + ask.length === 0) return { access: "full" };
  return {
    access: "custom",
    allow,
    ask,
    otherReads: "ask",
    otherWrites: "ask",
  };
};

/** How restrictive a catch-all choice is: Never > Needs approval > Allowed. */
const strictness = (choice: UnlistedChoice): number =>
  choice === "never" ? 2 : choice === "ask" ? 1 : 0;

const unlistedRule = (
  name: string,
  choice: UnlistedChoice,
  conditions: Prisma.JsonValue | null,
  method?: string,
): CompiledRule => {
  const narrowed = method ? { method } : {};
  return choice === "never"
    ? { name, action: "block", requireApproval: false, tools: [], ...narrowed }
    : {
        name,
        action: "allow",
        requireApproval: choice === "ask",
        tools: [],
        conditions,
        ...narrowed,
      };
};

/** The §4.2 stack for one (agent, connection) grant. Order is load-bearing:
 * first-match walks allow → ask → blocked → everything-else.
 *
 * The terminal "everything else" row covers the requests the catalog does not
 * describe, and they NEED APPROVAL. A block would dead-end ordinary flows
 * whose prerequisite calls no catalog lists (a Cloudflare deploy's
 * `GET /accounts`), and falling through to the Default Rule (usually Allow)
 * would inject the credential on the surfaces a catalog leaves out on purpose
 * (Salesforce Composite/Bulk can mass-delete), quietly undoing a "Never" on
 * the matching tool. A catalog opting in with `unlisted: "block"` (AWS, whose
 * credential spans every service) defaults it to a block instead when the
 * grant leaves the catch-alls unset.
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
 * row regardless of this ordering: the blocked complement always carries every
 * tool the user did not pick, and sits BEFORE the terminal, so an unpicked
 * catalogued mutation never reaches the approval terminal. */
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
  const terminal = `${nameBase}: everything else`;
  const fallback = defaultUnlisted(provider);
  const otherReads = input.otherReads ?? fallback;
  const otherWrites = input.otherWrites ?? fallback;
  if (otherReads === otherWrites) {
    // One terminal over everything unlisted: byte-identical to every stack
    // written before the two rows existed, so those keep matching and the
    // next unchanged save writes nothing.
    stack.push(unlistedRule(terminal, otherWrites, conditions));
    return stack;
  }
  // Two rows. The STRICTER choice comes first and is the one narrowed by
  // method, the looser one is the plain whole-app row after it. A gateway
  // that predates method narrowing reads the first row as whole-app, so
  // mid-deploy it applies the stricter choice to everything unlisted: never
  // looser than the user asked. Both sit after the blocked complement, so a
  // tool set to Never stays blocked whatever the catch-alls say.
  const reads = { name: `${nameBase}: all other reads`, choice: otherReads };
  const writes = { name: `${nameBase}: all other writes`, choice: otherWrites };
  stack.push(
    ...(strictness(otherReads) > strictness(otherWrites)
      ? [
          unlistedRule(reads.name, reads.choice, conditions, READS_ONLY),
          unlistedRule(writes.name, writes.choice, conditions),
        ]
      : [
          unlistedRule(writes.name, writes.choice, conditions, ALL_BUT_READS),
          unlistedRule(reads.name, reads.choice, conditions),
        ]),
  );
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
      (row.targets[0]?.method ?? "") === (want.method ?? "") &&
      sorted(row.targets[0]?.appTools ?? []).join("\n") ===
        want.tools.join("\n")
    );
  });

const unlistedChoiceOf = (row: PolicyRuleRow): UnlistedChoice =>
  row.action === "block" ? "never" : row.requireApproval ? "ask" : "allow";

const READ_METHODS = new Set(READS_ONLY.split(","));

/**
 * The choice a catalog tool reads back as when no row of its stack names it:
 * a tool added to the catalog after the stack was written. The catch-alls are
 * the user's choice for exactly those ("including tools added later"), so it
 * takes theirs: Other reads for a GET/HEAD-only tool, Other writes for one
 * with no read method, and the stricter of the two for a tool spanning both
 * (or any method), so it never reads looser than its catch-all. A save then
 * names it with that choice, where reading it as Never would have blocked it.
 */
const unlistedChoiceForTool = (
  tool: AppTool,
  otherReads: UnlistedChoice,
  otherWrites: UnlistedChoice,
): UnlistedChoice => {
  const methods = methodsOf(tool).map((m) => m.toUpperCase());
  if (methods.length > 0 && methods.every((m) => READ_METHODS.has(m))) {
    return otherReads;
  }
  if (methods.length > 0 && methods.every((m) => !READ_METHODS.has(m))) {
    return otherWrites;
  }
  return strictness(otherReads) >= strictness(otherWrites)
    ? otherReads
    : otherWrites;
};

/** Fold one connection's stack rows back into the tri-state intent, plus the
 * two catch-all choices ("All other reads" / "All other writes"). A catalog
 * tool the stack doesn't name reads as the catch-all choice it falls to
 * (`unlistedChoiceForTool`), never as Never: the blocked row names every tool
 * that is. */
export const stackToGrant = (
  rows: PolicyRuleRow[],
  provider: string,
): {
  access: "full" | "custom";
  allow: string[];
  ask: string[];
  otherReads: UnlistedChoice;
  otherWrites: UnlistedChoice;
} => {
  const isFull =
    rows.length === 1 &&
    rows[0]?.action === "allow" &&
    !rows[0].requireApproval &&
    (rows[0].targets[0]?.appTools ?? []).length === 0;
  if (isFull) {
    return {
      access: "full",
      allow: [],
      ask: [],
      otherReads: "allow",
      otherWrites: "allow",
    };
  }
  // The catch-alls name no tools (they are the unlisted-requests rows, not
  // tools the user picked), so they add nothing to `allow`/`ask`. With one
  // catch-all (no method narrowing) it covers both families; with two, the
  // narrowed one says which family it is and the plain one is the other.
  const wholeApp = rows.filter(
    (r) => (r.targets[0]?.appTools ?? []).length === 0,
  );
  const narrowed = wholeApp.find((r) => (r.targets[0]?.method ?? "") !== "");
  const plain = wholeApp.find((r) => (r.targets[0]?.method ?? "") === "");
  const plainChoice = plain ? unlistedChoiceOf(plain) : "ask";
  const narrowedChoice = narrowed ? unlistedChoiceOf(narrowed) : plainChoice;
  const readsNarrowed = narrowed?.targets[0]?.method === READS_ONLY;
  const otherReads = readsNarrowed ? narrowedChoice : plainChoice;
  const otherWrites = readsNarrowed ? plainChoice : narrowedChoice;
  const named = new Set(rows.flatMap((r) => r.targets[0]?.appTools ?? []));
  const addedLater = (getAppPermissionDefinition(provider)?.groups ?? [])
    .flatMap((g) => g.tools)
    .filter((tool) => !named.has(tool.id));
  const addedAs = (choice: UnlistedChoice) =>
    addedLater
      .filter(
        (tool) =>
          unlistedChoiceForTool(tool, otherReads, otherWrites) === choice,
      )
      .map((tool) => tool.id);
  const allow = [
    ...rows
      .filter((r) => r.action === "allow" && !r.requireApproval)
      .flatMap((r) => r.targets[0]?.appTools ?? []),
    ...addedAs("allow"),
  ];
  const ask = [
    ...rows
      .filter((r) => r.action === "allow" && r.requireApproval)
      .flatMap((r) => r.targets[0]?.appTools ?? []),
    ...addedAs("ask"),
  ];
  return {
    access: "custom",
    allow: sorted(allow),
    ask: sorted(ask),
    otherReads,
    otherWrites,
  };
};

/**
 * A customized grant input with its ABSENT catch-all choices filled from the
 * existing stack, when that stack is a customized one: a tools-only save (an
 * older client, the SDK) must never quietly reset "All other reads" to its
 * default. A first customization (no stack yet, or a full-access one) keeps
 * them absent, so the compiler applies the provider default.
 */
export const withStoredUnlisted = (
  input: ConnectionGrantInput,
  existing: PolicyRuleRow[],
  provider: string,
): ConnectionGrantInput => {
  if (input.access !== "custom" || existing.length === 0) return input;
  const stored = stackToGrant(existing, provider);
  if (stored.access !== "custom") return input;
  return {
    ...input,
    otherReads: input.otherReads ?? stored.otherReads,
    otherWrites: input.otherWrites ?? stored.otherWrites,
  };
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
