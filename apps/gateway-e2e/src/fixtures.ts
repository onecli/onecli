import { cryptoService } from "@onecli/api/lib/crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { TestIds } from "./ids.js";

/**
 * Prisma-typed fixtures for one test, written into that test's own database.
 *
 * Typed on purpose — every row goes through the generated client, so a renamed
 * or retyped schema column breaks `check-types` rather than surfacing as a
 * mystifying gateway failure at runtime. This mirrors
 * `packages/api/src/ee/testing/gateway-enforce-seed.ts`.
 *
 * Note what is deliberately absent: nothing here accepts an org, workspace, agent
 * or token id. Those come from the per-test nonce and are the suite's Redis
 * isolation mechanism (see `ids.ts`), so a test must not be able to pin one.
 */

/**
 * How a secret is injected. The gateway derives this from the secret's `type`
 * for the provider types (`anthropic`, `openai`); `generic` reads
 * `injectionConfig`, and exactly one of these shapes applies —
 * `headerName` wins if several are set (`secret_inject.rs:100`).
 */
export interface InjectionSpec {
  /** Header to inject, e.g. `x-test-key`. */
  readonly headerName?: string;
  /** e.g. `Bearer {value}`. Omit to inject the raw value. */
  readonly valueFormat?: string;
  /** Query parameter to inject. */
  readonly paramName?: string;
  readonly paramFormat?: string;
  /** Path template carrying `{value}`, e.g. `/bot{value}/sendMessage`. */
  readonly pathTemplate?: string;
  /** Regex + replacement rewrite of the request path. Both required. */
  readonly pathRegex?: string;
  readonly pathReplacement?: string;
}

/** A credential the gateway should inject on matching requests. */
export interface SecretSpec extends InjectionSpec {
  /** Host the credential is scoped to, e.g. `127.0.0.1`. */
  readonly hostPattern: string;
  /** Plaintext. Stored via the production local-AES encryptor (the enterprise
   * self-host backend); the spawned gateway decrypts it with the same key. */
  readonly value: string;
  /**
   * Omitted means `"*"` — every path. `/a/*` is boundary-aware (matches `/a`
   * and `/a/b`, not `/ax`); `/a*` is a bare prefix (matches `/ax` too).
   */
  readonly pathPattern?: string;
  /**
   * Defaults to `generic`, the one type whose host pattern passes through
   * verbatim so it can target a local stub. `anthropic` / `openai` derive
   * their injection from the type and ignore `injectionConfig`.
   */
  readonly type?: "generic" | "anthropic" | "openai";
  /**
   * `organization` stores the row against the org with a null workspace — the
   * only shape `find_secrets_by_org` returns. Defaults to `workspace`.
   */
  readonly scope?: "workspace" | "organization";
}

/**
 * Only the target kinds the suite actually exercises.
 *
 * The `secretScope` ("all secrets at this level") form is deliberately absent:
 * an unused fixture path is an untested one, and it has its own
 * CHECK-constrained column layout. Add it back together with the test that
 * drives it.
 */
export interface RuleTargetSpec {
  /** Defaults to `network`. */
  readonly kind?: "network" | "secret" | "connection" | "app";
  /** `kind: "app"` — the provider whose connections the rule names. */
  readonly provider?: string;
  /** `kind: "app"` — with a scope, the target means "all of this agent's
   * connections of `provider` at that level", and the ids are resolved from
   * the database rather than named here. Without one it is a block/allow
   * app-permission target that injects nothing. */
  readonly connectionScope?: "workspace" | "organization";
  readonly hostPattern?: string;
  readonly pathPattern?: string;
  readonly method?: string;
  /** `kind: "secret"` — index into `WorldSpec.secrets`. */
  readonly secretIndex?: number;
  /** `kind: "connection"` — index into `WorldSpec.appConnections`; the rule
   * binds to that specific connection (per-connection decisions). */
  readonly connectionIndex?: number;
  /** `kind: "connection" | "app"` - catalog tool ids narrowing the target to
   * those tools' endpoint fan-out (the production grant stacks' shape). Empty
   * or omitted = the whole app. */
  readonly tools?: ReadonlyArray<string>;
}

/** A `body contains` condition. The matcher lowercases both sides. */
export interface ConditionSpec {
  readonly target: "body";
  readonly operator: "contains";
  readonly value: string;
}

/**
 * Which principals a rule binds.
 *
 * The asymmetry worth knowing: an empty identity set means "any principal" for
 * a DECISION, but never matches for INJECTION selection
 * (`ee/policy_engine/inject_select.rs`).
 */
export type IdentitySpec =
  | "agent"
  | "user"
  | "user-via-group"
  | "group"
  | "other-agent";

export interface RuleSpec {
  readonly name: string;
  readonly action: "allow" | "block";
  readonly requireApproval?: boolean;
  readonly rateLimit?: number;
  readonly rateLimitWindow?: "minute" | "hour" | "day";
  readonly enabled?: boolean;
  /**
   * On a NON-default rule, empty or omitted targets match NOTHING — the rule
   * is inert (`evaluate.rs:89`). Only `isDefault` rules mean "any destination".
   */
  readonly targets?: ReadonlyArray<RuleTargetSpec>;
  /** `organization` rules apply across the org and form a hard floor. */
  readonly scope?: "workspace" | "organization";
  /** The gateway loads only `published`. `draft` must never be enforced. */
  readonly status?: "draft" | "published";
  /** The terminal per-level Default Rule. */
  readonly isDefault?: boolean;
  readonly source?: "custom" | "default" | "grant";
  /** Lower wins first-match within a scope. Defaults to declaration order. */
  readonly priority?: number;
  /** Only evaluated by the EE engine; the OSS stub carries but ignores them. */
  readonly conditions?: ReadonlyArray<ConditionSpec>;
  /**
   * A resource scope ("Resources") on a CONNECTION target: which repositories
   * or folders the injected credential may reach. Stored in the same
   * `conditions` column as the behavioral list above and mutually exclusive
   * with it — an object is a resource scope, an array is behavioral.
   *
   * An ORG rule's scope is a BOUNDARY (it binds even with no identities); a
   * workspace rule's is a SELECTION within it. An empty list reaches nothing.
   */
  readonly resources?:
    | { readonly repositories: ReadonlyArray<string> }
    | { readonly folders: ReadonlyArray<string> };
  readonly identities?: ReadonlyArray<IdentitySpec>;
}

/**
 * A connected OAuth app.
 *
 * The credentials are a real AES ciphertext but are never decrypted by the
 * tests that use this: they assert on resolution outcomes (ambiguity,
 * not-found) which are decided by grouping connections on `provider` and
 * `id`, before any credential is touched.
 */
export interface AppConnectionSpec {
  readonly provider: string;
  readonly label?: string;
  /**
   * `organization` stores the row against the org with a null workspace — the
   * only shape `find_app_connections_by_org` returns (an org row with a
   * workspace id set would be returned by BOTH fenced queries and duplicated
   * in the pool). Defaults to `workspace`.
   */
  readonly scope?: "workspace" | "organization";
}

export interface WorldSpec {
  readonly secrets?: ReadonlyArray<SecretSpec>;
  readonly appConnections?: ReadonlyArray<AppConnectionSpec>;
  readonly rules?: ReadonlyArray<RuleSpec>;
  /** Seed a user + `oc_` API key for the control-plane routes. */
  readonly withApiKey?: boolean;
  /**
   * Seed a user + `oc_org_` organization key — the released-SDK org-approvals
   * watcher's credential (scope "organization", no workspace of its own).
   */
  readonly withOrgApiKey?: boolean;
  /**
   * `restricted` gates every identifiable app provider on an explicit
   * availability grant; with no grants seeded, that blocks all of them.
   */
  readonly appAvailabilityMode?: "open" | "restricted";
  /**
   * Attach every seeded org/workspace secret and app connection to the main
   * agent: one `source:"grant"` PUBLISHED allow rule per credential (identity:
   * the agent; target: that credential), mirroring the production attach write
   * — workspace scope, one agent identity, tail-band priority (1000+, AFTER
   * every spec rule, so spec rules keep first-match precedence; a spec rule
   * claiming priority ≥ 1000 throws).
   *
   * DELIBERATELY no hidden default: a grant is also an ALLOW in decisions, so
   * an implicit grant would silently rewrite block/default assertions. A world
   * that wants injection must say so. Throws when there is nothing to grant.
   */
  readonly grantAll?: boolean;
}

/**
 * A target row shaped for its kind.
 *
 * The `policy_rule_targets_kind_shape` CHECK requires every column belonging to
 * another kind to be NULL, so these cannot be merged into one object with
 * optional fields — a stray `hostPattern` on a `secret` target is rejected by
 * Postgres, not silently ignored.
 */
const targetRow = (
  id: string,
  target: RuleTargetSpec,
  secretIds: ReadonlyArray<string>,
  connectionIds: ReadonlyArray<string>,
): Prisma.PolicyRuleTargetCreateWithoutRuleInput => {
  const kind = target.kind ?? "network";
  const narrowing = {
    pathPattern: target.pathPattern ?? null,
    method: target.method ?? null,
  };
  // Each shape is validated here rather than left to Postgres. The CHECK does
  // reject all of these, but as an opaque constraint error naming neither the
  // rule nor the field — and the likeliest mistake, a network target narrowed
  // by path with no host, reads like a perfectly reasonable thing to write.
  if (kind === "secret") {
    const secretId = secretIds[target.secretIndex ?? -1];
    if (secretId === undefined) {
      throw new Error(
        `${id}: secretIndex ${String(target.secretIndex)} does not name a seeded secret (${String(secretIds.length)} seeded)`,
      );
    }
    return { id, kind, ...narrowing, secret: { connect: { id: secretId } } };
  }
  if (kind === "connection") {
    // The CHECK rejects path/method narrowing columns on a connection row;
    // narrowing is the `appTools` axis (`tools` - the grant stacks' shape).
    const connectionId = connectionIds[target.connectionIndex ?? -1];
    if (connectionId === undefined) {
      throw new Error(
        `${id}: connectionIndex ${String(target.connectionIndex)} does not name a seeded connection (${String(connectionIds.length)} seeded)`,
      );
    }
    return {
      id,
      kind,
      appConnection: { connect: { id: connectionId } },
      ...(target.tools !== undefined && target.tools.length > 0
        ? { appTools: [...target.tools] }
        : {}),
    };
  }
  if (kind === "app") {
    if (target.provider === undefined) {
      throw new Error(`${id}: an app target needs a provider`);
    }
    // The CHECK rejects host/path/method columns on an app row.
    return {
      id,
      kind,
      appProvider: target.provider,
      appConnectionScope: target.connectionScope ?? null,
      ...(target.tools !== undefined && target.tools.length > 0
        ? { appTools: [...target.tools] }
        : {}),
    };
  }
  if (target.hostPattern === undefined) {
    throw new Error(`${id}: a network target needs hostPattern`);
  }
  return { id, kind, ...narrowing, hostPattern: target.hostPattern };
};

/** Exactly one principal column may be set (`policy_rule_identities_one_principal`). */
const identityRow = (
  id: string,
  principal: IdentitySpec,
  ids: TestIds,
): Prisma.PolicyRuleIdentityCreateWithoutRuleInput => {
  switch (principal) {
    case "agent":
      return { id, agent: { connect: { id: ids.agent } } };
    // The RULE names the same user either way — only the GRANT path differs
    // (a direct WorkspaceAccess row vs inheritance through a granted group).
    case "user":
    case "user-via-group":
      return { id, user: { connect: { id: ids.user } } };
    case "group":
      return { id, group: { connect: { id: ids.group } } };
    case "other-agent":
      return { id, agent: { connect: { id: ids.otherAgent } } };
  }
};

const injectionConfig = (spec: InjectionSpec): Prisma.InputJsonValue => {
  const config: Record<string, string> = {};
  if (spec.headerName !== undefined) config.headerName = spec.headerName;
  if (spec.valueFormat !== undefined) config.valueFormat = spec.valueFormat;
  if (spec.paramName !== undefined) config.paramName = spec.paramName;
  if (spec.paramFormat !== undefined) config.paramFormat = spec.paramFormat;
  if (spec.pathTemplate !== undefined) config.pathTemplate = spec.pathTemplate;
  if (spec.pathRegex !== undefined) config.pathRegex = spec.pathRegex;
  if (spec.pathReplacement !== undefined) {
    config.pathReplacement = spec.pathReplacement;
  }
  return config;
};

/** Grant-band floor: `grantAll` rules seed at 1000+ so every spec rule keeps
 * first-match precedence; the seeder rejects spec priorities that reach it. */
const GRANT_PRIORITY_BAND = 1000;

/** One `source:"grant"` published allow rule attaching a credential to the
 * main agent — the shape the production grants compiler writes. */
const createGrantRule = async (
  prisma: PrismaClient,
  ids: TestIds,
  grant: {
    ruleId: string;
    name: string;
    priority: number;
    target:
      | { kind: "secret"; secretId: string }
      | { kind: "connection"; appConnectionId: string };
  },
): Promise<void> => {
  await prisma.policyRuleV2.create({
    data: {
      id: grant.ruleId,
      scope: "workspace",
      workspaceId: ids.workspace,
      status: "published",
      generation: 1,
      enabled: true,
      isDefault: false,
      source: "grant",
      priority: grant.priority,
      name: grant.name,
      action: "allow",
      requireApproval: false,
      targets: {
        create: [
          grant.target.kind === "secret"
            ? {
                id: `${grant.ruleId}-t0`,
                kind: "secret",
                secret: { connect: { id: grant.target.secretId } },
              }
            : {
                id: `${grant.ruleId}-t0`,
                kind: "connection",
                appConnection: {
                  connect: { id: grant.target.appConnectionId },
                },
              },
        ],
      },
      identities: {
        create: [identityRow(`${grant.ruleId}-i0`, "agent", ids)],
      },
    },
  });
};

/**
 * Attach one already-seeded secret to the main agent — the grant half of what
 * a production attach writes. Pairs with `addSecret` for the connect-cache
 * test: credential + grant land together behind the stale cache, and
 * invalidation refreshes both (the cached `ConnectResponse` embeds the rules
 * AND the injections).
 */
export const grantSecret = async (
  prisma: PrismaClient,
  ids: TestIds,
  secretId = `${ids.workspace}-sec-late`,
): Promise<void> => {
  await createGrantRule(prisma, ids, {
    ruleId: `${ids.workspace}-grant-late`,
    name: "grant-late",
    priority: GRANT_PRIORITY_BAND + 900,
    target: { kind: "secret", secretId },
  });
};

/**
 * Write one secret row.
 *
 * Separate from `seedWorld` so a test can add a credential *after* the gateway
 * has already resolved and cached a connection — which is the only way to
 * observe the connect cache, and therefore the only way to prove invalidating
 * it actually does something.
 */
export const addSecret = async (
  prisma: PrismaClient,
  ids: TestIds,
  secret: SecretSpec,
  id = `${ids.workspace}-sec-late`,
): Promise<void> => {
  const scope = secret.scope ?? "workspace";
  const type = secret.type ?? "generic";
  const config = injectionConfig(secret);
  if (type === "generic" && Object.keys(config).length === 0) {
    // A generic secret with no injection spec is fenced in but never injected,
    // so an assertion written against it can only ever pass. The provider types
    // derive their injection from the type and need no config.
    throw new Error(
      `${id}: a generic secret needs an injection spec (headerName / paramName / pathTemplate / pathRegex)`,
    );
  }
  await prisma.secret.create({
    data: {
      id,
      name: id,
      type: secret.type ?? "generic",
      scope,
      // An org-scoped row must have a NULL workspace: `find_secrets_by_workspace`
      // does not filter on scope, so a workspace id would return it twice.
      workspaceId: scope === "workspace" ? ids.workspace : null,
      organizationId: ids.org,
      valueSource: "inline",
      // The production encryptor, against the same AES key the gateway
      // decrypts with. This is what makes the TS→Rust 3-part format contract
      // a real assertion rather than Rust agreeing with itself.
      encryptedValue: await cryptoService.encrypt(secret.value),
      hostPattern: secret.hostPattern,
      pathPattern: secret.pathPattern ?? null,
      injectionConfig: config,
    },
  });
};

/** A resource scope as Prisma JSON: copied into a plain, mutable object for
 * the same reason the behavioral conditions are spread. */
const resourceConditions = (
  resources: NonNullable<RuleSpec["resources"]>,
): Record<string, string[]> =>
  "repositories" in resources
    ? { repositories: [...resources.repositories] }
    : { folders: [...resources.folders] };

/** The two condition shapes share one column and cannot coexist. Caught here,
 * loudly, rather than silently preferring one — the same reason the target
 * shapes are validated above instead of being left to the CHECK. */
const assertOneConditionShape = (rule: RuleSpec): void => {
  if (rule.resources !== undefined && rule.conditions !== undefined) {
    throw new Error(
      `${rule.name}: a rule carries EITHER behavioral conditions OR a resource scope, never both`,
    );
  }
};

export const seedWorld = async (
  prisma: PrismaClient,
  ids: TestIds,
  spec: WorldSpec = {},
): Promise<void> => {
  await prisma.organization.create({
    data: {
      id: ids.org,
      name: ids.org,
      slug: ids.org,
      appAvailabilityMode: spec.appAvailabilityMode ?? "open",
    },
  });
  await prisma.workspace.create({
    data: { id: ids.workspace, name: ids.workspace, organizationId: ids.org },
  });

  await prisma.agent.create({
    data: {
      id: ids.agent,
      workspaceId: ids.workspace,
      name: ids.agent,
      identifier: ids.agent,
      accessToken: ids.agentToken,
    },
  });

  const secretIds = (spec.secrets ?? []).map(
    (_, i) => `${ids.workspace}-sec-${String(i)}`,
  );
  for (const [i, secret] of (spec.secrets ?? []).entries()) {
    await addSecret(prisma, ids, secret, secretIds[i]);
  }

  const connectionIds = (spec.appConnections ?? []).map(
    (_, i) => `${ids.workspace}-conn-${String(i)}`,
  );
  for (const [i, connection] of (spec.appConnections ?? []).entries()) {
    const orgScoped = connection.scope === "organization";
    await prisma.appConnection.create({
      data: {
        id: connectionIds[i] ?? `${ids.workspace}-conn-${String(i)}`,
        scope: orgScoped ? "organization" : "workspace",
        // Org rows carry a NULL workspace id (see AppConnectionSpec.scope).
        workspaceId: orgScoped ? null : ids.workspace,
        organizationId: ids.org,
        provider: connection.provider,
        label: connection.label ?? `${connection.provider}-${String(i)}`,
        status: "connected",
        credentials: await cryptoService.encrypt(
          JSON.stringify({ access_token: `e2e-oauth-${String(i)}` }),
        ),
      },
    });
  }

  // A rule bound to a `user` reaches the agent only through the connect-time
  // principal-set resolution (`find_principal_set`): the user must be an
  // ACTIVE org member AND bound to the agent's workspace via WorkspaceAccess.
  const needsUser = (spec.rules ?? []).some((r) =>
    r.identities?.includes("user"),
  );
  // The inheritance twin: the SAME user, granted the workspace only through a
  // granted group's membership (no direct WorkspaceAccess row) — the licensed
  // CTE inherits them, the free direct-user twin does not.
  const needsUserViaGroup = (spec.rules ?? []).some((r) =>
    r.identities?.includes("user-via-group"),
  );
  if ((needsUser || needsUserViaGroup) && spec.withApiKey === true) {
    // Both blocks create the same `ids.user` row; combining them would die on
    // a unique constraint with a message naming neither block.
    throw new Error(
      "RuleSpec: a 'user'/'user-via-group' identity cannot combine with withApiKey — both seed ids.user.",
    );
  }
  // A rule bound to a `group` reaches the agent through the CTE's
  // `direct_groups` arm: the group is org-scoped and granted to the agent's
  // workspace via WorkspaceAccess.
  const needsGroup = (spec.rules ?? []).some((r) =>
    r.identities?.includes("group"),
  );
  if (needsGroup && needsUserViaGroup) {
    throw new Error(
      "RuleSpec: 'group' and 'user-via-group' cannot combine — both seed ids.group.",
    );
  }
  if (needsUser && needsUserViaGroup) {
    throw new Error(
      "RuleSpec: 'user' and 'user-via-group' cannot combine — both seed ids.user with conflicting grants.",
    );
  }
  if (needsUser) {
    const email = `${ids.nonce}@e2e.invalid`;
    await prisma.user.create({
      data: { id: ids.user, email, externalAuthId: ids.user },
    });
    await prisma.organizationMember.create({
      data: {
        organizationId: ids.org,
        userId: ids.user,
        userEmail: email,
        role: "member",
      },
    });
    await prisma.workspaceAccess.create({
      data: {
        id: `${ids.workspace}-pa`,
        workspaceId: ids.workspace,
        userId: ids.user,
      },
    });
  }

  if (needsUserViaGroup) {
    const email = `${ids.nonce}@e2e.invalid`;
    await prisma.user.create({
      data: { id: ids.user, email, externalAuthId: ids.user },
    });
    await prisma.organizationMember.create({
      data: {
        organizationId: ids.org,
        userId: ids.user,
        userEmail: email,
        role: "member",
      },
    });
    // The grant path: a group granted to the workspace, with the user as a
    // member — deliberately NO direct WorkspaceAccess user row.
    await prisma.group.create({
      data: { id: ids.group, organizationId: ids.org, name: ids.group },
    });
    await prisma.groupMember.create({
      data: { groupId: ids.group, userId: ids.user },
    });
    await prisma.workspaceAccess.create({
      data: {
        id: `${ids.workspace}-pa-group`,
        workspaceId: ids.workspace,
        groupId: ids.group,
      },
    });
  }

  if (needsGroup) {
    await prisma.group.create({
      data: { id: ids.group, organizationId: ids.org, name: ids.group },
    });
    await prisma.workspaceAccess.create({
      data: {
        id: `${ids.workspace}-pa-group`,
        workspaceId: ids.workspace,
        groupId: ids.group,
      },
    });
  }

  const needsOtherAgent = (spec.rules ?? []).some((r) =>
    r.identities?.includes("other-agent"),
  );
  if (needsOtherAgent) {
    await prisma.agent.create({
      data: {
        id: ids.otherAgent,
        workspaceId: ids.workspace,
        name: ids.otherAgent,
        identifier: ids.otherAgent,
        accessToken: `${ids.agentToken}-other`,
      },
    });
  }

  for (const [i, rule] of (spec.rules ?? []).entries()) {
    assertOneConditionShape(rule);
    const ruleId = `${ids.workspace}-rule-${String(i)}`;
    const scope = rule.scope ?? "workspace";
    if ((rule.priority ?? i + 1) >= GRANT_PRIORITY_BAND) {
      throw new Error(
        `RuleSpec: priorities >= ${String(GRANT_PRIORITY_BAND)} are reserved for the grant band (grantAll)`,
      );
    }
    await prisma.policyRuleV2.create({
      data: {
        id: ruleId,
        scope,
        // `policy_rules_v2_scope_shape` requires exactly one of these — an org
        // rule carries no workspace id and a workspace rule carries no org id.
        organizationId: scope === "organization" ? ids.org : null,
        workspaceId: scope === "organization" ? null : ids.workspace,
        // The gateway loads only published rules at the highest generation.
        status: rule.status ?? "published",
        generation: 1,
        enabled: rule.enabled ?? true,
        isDefault: rule.isDefault ?? false,
        source: rule.source ?? (rule.isDefault === true ? "default" : "custom"),
        priority: rule.priority ?? i + 1,
        name: rule.name,
        action: rule.action,
        requireApproval: rule.requireApproval ?? false,
        rateLimit: rule.rateLimit ?? null,
        rateLimitWindow: rule.rateLimitWindow ?? null,
        // Spread into plain objects rather than asserted: a readonly array of
        // readonly records is not assignable to Prisma's JSON input type, but
        // a copy of it is — no cast needed.
        conditions:
          rule.resources !== undefined
            ? resourceConditions(rule.resources)
            : rule.conditions?.map((c) => ({ ...c })),
        targets:
          rule.targets !== undefined && rule.targets.length > 0
            ? {
                create: rule.targets.map((t, ti) =>
                  targetRow(
                    `${ruleId}-t${String(ti)}`,
                    t,
                    secretIds,
                    connectionIds,
                  ),
                ),
              }
            : undefined,
        identities:
          rule.identities !== undefined && rule.identities.length > 0
            ? {
                create: rule.identities.map((principal, pi) =>
                  identityRow(`${ruleId}-i${String(pi)}`, principal, ids),
                ),
              }
            : undefined,
      },
    });
  }

  if (spec.grantAll === true) {
    const grantable = [
      ...(spec.secrets ?? []).map((_, i) => ({ kind: "secret" as const, i })),
      ...(spec.appConnections ?? []).map((_, i) => ({
        kind: "connection" as const,
        i,
      })),
    ];
    if (grantable.length === 0) {
      throw new Error("grantAll: no secrets or app connections to grant");
    }
    for (const [seq, g] of grantable.entries()) {
      const targetId =
        g.kind === "secret" ? secretIds[g.i] : connectionIds[g.i];
      if (targetId === undefined) continue; // unreachable — same-length maps
      await createGrantRule(prisma, ids, {
        ruleId: `${ids.workspace}-grant-${g.kind === "secret" ? "s" : "c"}${String(g.i)}`,
        name: `grant-${g.kind === "secret" ? "sec" : "conn"}-${String(g.i)}`,
        priority: GRANT_PRIORITY_BAND + seq,
        target:
          g.kind === "secret"
            ? { kind: "secret", secretId: targetId }
            : { kind: "connection", appConnectionId: targetId },
      });
    }
  }

  if (spec.withApiKey === true || spec.withOrgApiKey === true) {
    const email = `${ids.nonce}@e2e.invalid`;
    await prisma.user.create({
      data: { id: ids.user, email, externalAuthId: ids.user },
    });
    // Cloud re-checks workspace access (and org-key admin role) on every
    // request, and an owner row is the simplest thing that satisfies both.
    await prisma.organizationMember.create({
      data: {
        organizationId: ids.org,
        userId: ids.user,
        userEmail: email,
        role: "owner",
      },
    });
    if (spec.withApiKey === true) {
      await prisma.apiKey.create({
        data: {
          id: `${ids.workspace}-key`,
          key: ids.apiKey,
          scope: "workspace",
          workspaceId: ids.workspace,
          userId: ids.user,
          userEmail: email,
        },
      });
    }
    if (spec.withOrgApiKey === true) {
      await prisma.apiKey.create({
        data: {
          id: `${ids.workspace}-org-key`,
          key: ids.orgApiKey,
          scope: "organization",
          organizationId: ids.org,
          userId: ids.user,
          userEmail: email,
        },
      });
    }
  }
};
