import { Hono } from "hono";
import { logger } from "../../lib/logger";
import { AUDIT_ACTIONS, AUDIT_SERVICES } from "../../services/audit-service";
import { ServiceError } from "../../services/errors";
import {
  deactivateMember,
  findMemberByEmail,
  findMemberByUserId,
  listMembersOffset,
  provisionMember,
  reactivateMember,
  renameMemberEmail,
  resolveScimActor,
  updateMemberProfile,
} from "../services/org-directory-service";
import type { DirectoryMember } from "../services/org-directory-service";
import { Prisma } from "@onecli/db";
import { type ScimEnv } from "./auth";
import { scimAudit } from "./audit";
import { ScimError } from "./errors";
import { parseSupportedEqFilter } from "./filter";
import {
  coerceScimBoolean,
  parsePatchBody,
  parseScimPath,
  scimAttr,
} from "./patch";
import { readScimBody, scimJson, scimResource } from "./respond";
import {
  parsePagination,
  scimBaseUrl,
  toListResponse,
  toScimUser,
} from "./serialization";

const log = logger.child({ component: "scim-users" });

/**
 * /scim/v2/Users — 12a. The user identity key is userName (the email);
 * externalId is accepted on writes but not persisted (no storage column),
 * so `externalId eq` filters get explicit guidance instead of silently
 * matching nothing. Deactivation is step-9 suspension: every authorization
 * check gates on it and API keys are blocked at auth-time — nothing is
 * deleted, so Okta's routine reactivation restores cleanly.
 */

const USER_FILTER_HINT =
  "Match users by userName (email) — externalId is not stored for users.";

const requireMember = async (
  organizationId: string,
  userId: string,
): Promise<DirectoryMember> => {
  const member = await findMemberByUserId(organizationId, userId);
  if (!member) throw new ScimError(404, "User not found.");
  return member;
};

const requireUserName = (body: Record<string, unknown>): string => {
  const userName = scimAttr(body, "userName");
  if (typeof userName !== "string" || userName.trim().length === 0) {
    throw new ScimError(400, "userName is required.", "invalidValue");
  }
  return userName;
};

/**
 * Objects that came out of `JSON.parse` (every SCIM request body) are JSON
 * values by construction — this is the one narrowing the type system can't
 * see on its own.
 */
const asJsonObject = (value: Record<string, unknown>) =>
  value as Prisma.InputJsonObject;

/**
 * The SCIM `name` object from a payload, stored verbatim so every
 * sub-attribute round-trips. `undefined` = not provided.
 */
const nameComponentsFrom = (
  body: Record<string, unknown>,
): Prisma.InputJsonObject | undefined => {
  const name = scimAttr(body, "name");
  if (typeof name !== "object" || name === null || Array.isArray(name)) {
    return undefined;
  }
  return asJsonObject(name as Record<string, unknown>);
};

/**
 * Display string for `User.name`: the displayName attribute, falling back
 * to name.formatted, then givenName + familyName — so member lists stay
 * readable even when the IdP maps no displayName.
 */
const displayStringFrom = (
  body: Record<string, unknown>,
): string | undefined => {
  const displayName = scimAttr(body, "displayName");
  if (typeof displayName === "string" && displayName.trim()) {
    return displayName.trim();
  }
  const components = nameComponentsFrom(body);
  if (!components) return undefined;
  const formatted = scimAttr(components, "formatted");
  if (typeof formatted === "string" && formatted.trim()) {
    return formatted.trim();
  }
  const given = scimAttr(components, "givenName");
  const family = scimAttr(components, "familyName");
  const combined = [given, family]
    .filter((part): part is string => typeof part === "string" && !!part.trim())
    .map((part) => part.trim())
    .join(" ");
  return combined || undefined;
};

/** active with the Entra "True"/"False" quirk; undefined = not provided. */
const activeFrom = (body: Record<string, unknown>): boolean | undefined => {
  const raw = scimAttr(body, "active");
  if (raw === undefined) return undefined;
  const coerced = coerceScimBoolean(raw);
  if (coerced === null) {
    throw new ScimError(400, "active must be a boolean.", "invalidValue");
  }
  return coerced;
};

/** Path-parsed name sub-attributes come lowercased — restore canon casing. */
const CANONICAL_NAME_KEYS: Record<string, string> = {
  formatted: "formatted",
  givenname: "givenName",
  familyname: "familyName",
  middlename: "middleName",
  honorificprefix: "honorificPrefix",
  honorificsuffix: "honorificSuffix",
};

const storedComponents = (member: DirectoryMember): Record<string, unknown> => {
  const value = member.nameComponents;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
};

/**
 * userName (email) rename — guarded in the directory service (placeholder
 * or sole-org only). The guard's BAD_REQUEST would map to invalidValue via
 * the generic ServiceError bridge; re-shape it here to the semantically
 * correct `mutability` (RFC 7644 Table 9: "not compatible with the target
 * attribute's … current state").
 */
const applyUserName = async (
  organizationId: string,
  member: DirectoryMember,
  rawUserName: string,
): Promise<boolean> => {
  if (rawUserName.trim().toLowerCase() === member.email) return false;
  try {
    await renameMemberEmail(organizationId, member.userId, rawUserName);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "BAD_REQUEST") {
      throw new ScimError(400, err.message, "mutability");
    }
    throw err;
  }
  return true;
};

/** Apply an active flip via the step-9 suspension chain; true = changed. */
const applyActive = async (
  organizationId: string,
  member: DirectoryMember,
  active: boolean,
): Promise<boolean> => {
  const currentlyActive = member.status !== "suspended";
  if (active === currentlyActive) return false;
  if (active) {
    await reactivateMember(organizationId, member.userId);
  } else {
    const actor = await resolveScimActor(organizationId);
    await deactivateMember(organizationId, member.userId, actor.userId);
  }
  return true;
};

export const usersRouter = new Hono<ScimEnv>();

usersRouter.get("/", async (c) => {
  const { organizationId } = c.get("scim");
  const baseUrl = scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
  const filter = c.req.query("filter");

  if (filter !== undefined) {
    // Okta's lookup — and Entra's Test Connection, which probes a random
    // GUID and requires 200 + totalResults:0, never a 404.
    const parsed = parseSupportedEqFilter(
      filter,
      ["username"],
      USER_FILTER_HINT,
    );
    const member = await findMemberByEmail(organizationId, parsed.value);
    const resources = member ? [toScimUser(member, baseUrl)] : [];
    return scimJson(c, toListResponse(resources, resources.length, 1), 200);
  }

  const { startIndex, count } = parsePagination(c.req.query());
  const page = await listMembersOffset(organizationId, startIndex, count);
  return scimJson(
    c,
    toListResponse(
      page.members.map((m) => toScimUser(m, baseUrl)),
      page.totalResults,
      startIndex,
    ),
    200,
  );
});

usersRouter.get("/:id", async (c) => {
  const { organizationId } = c.get("scim");
  const member = await requireMember(organizationId, c.req.param("id"));
  return scimResource(
    c,
    toScimUser(
      member,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
  );
});

usersRouter.post("/", async (c) => {
  const scim = c.get("scim");
  const body = await readScimBody(c);
  const userName = requireUserName(body);
  const name = displayStringFrom(body);
  const nameComponents = nameComponentsFrom(body);
  const active = activeFrom(body);

  const result = await provisionMember(
    scim.organizationId,
    userName,
    name ?? null,
    nameComponents ?? null,
  );
  if (!result.created) {
    // Okta halts provisioning on 409 and shows `detail` in its console.
    throw new ScimError(
      409,
      `A user with userName "${result.email}" already exists in this organization.`,
      "uniqueness",
    );
  }
  if (active === false) {
    const actor = await resolveScimActor(scim.organizationId);
    await deactivateMember(scim.organizationId, result.userId, actor.userId);
  }

  await scimAudit(scim, AUDIT_ACTIONS.CREATE, AUDIT_SERVICES.MEMBER, {
    userId: result.userId,
    email: result.email,
    // Distinguishes "SCIM minted a brand-new user" from "an existing
    // OneCLI user joined this org".
    userCreated: result.userCreated,
  });

  const member = await requireMember(scim.organizationId, result.userId);
  return scimResource(
    c,
    toScimUser(
      member,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
    201,
  );
});

// Full replace — wizard-configured apps (and Okta profile pushes) use PUT.
usersRouter.put("/:id", async (c) => {
  const scim = c.get("scim");
  const member = await requireMember(scim.organizationId, c.req.param("id"));
  const body = await readScimBody(c);

  const userNameChanged = await applyUserName(
    scim.organizationId,
    member,
    requireUserName(body),
  );

  // Apply-if-provided (not clear-if-absent): IdPs always send the
  // attributes they manage; a wizard app that maps no name must not wipe
  // the profile of a possibly multi-org user.
  const profile: Parameters<typeof updateMemberProfile>[2] = {};
  const displayName = scimAttr(body, "displayName");
  if (typeof displayName === "string" && displayName.trim()) {
    profile.displayName = displayName.trim();
  }
  const components = nameComponentsFrom(body);
  if (components !== undefined) {
    profile.nameComponents = components;
    // Keep the member list readable when the IdP maps no displayName.
    if (profile.displayName === undefined && member.name === null) {
      profile.displayName = displayStringFrom(body) ?? null;
    }
  }
  const nameChanged = Object.keys(profile).length > 0;
  if (nameChanged) {
    await updateMemberProfile(scim.organizationId, member.userId, profile);
  }

  const active = activeFrom(body);
  const activeChanged =
    active === undefined
      ? false
      : await applyActive(scim.organizationId, member, active);

  const updated = await requireMember(scim.organizationId, member.userId);
  if (nameChanged || activeChanged || userNameChanged) {
    await scimAudit(scim, AUDIT_ACTIONS.UPDATE, AUDIT_SERVICES.MEMBER, {
      userId: member.userId,
      email: member.email,
      nameChanged,
      activeChanged,
      userNameChanged,
      // The rename target — "renamed to what?" must be answerable from
      // the audit row alone.
      ...(userNameChanged ? { newEmail: updated.email } : {}),
    });
  }

  return scimResource(
    c,
    toScimUser(
      updated,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
  );
});

usersRouter.patch("/:id", async (c) => {
  const scim = c.get("scim");
  const member = await requireMember(scim.organizationId, c.req.param("id"));
  const operations = parsePatchBody(await readScimBody(c));

  const changed = { name: false, active: false, userName: false };

  // Ops apply in order against the freshest state.
  let current = member;
  const refresh = async () => {
    current = await requireMember(scim.organizationId, member.userId);
  };

  // ONE attribute switch for both dialect forms: explicit `path` ops AND
  // the keys of a no-path value object (where Entra also uses DOTTED keys
  // like "name.givenName" — each key is parsed as a path expression).
  const applyAttribute = async (
    base: string,
    opKind: "add" | "remove" | "replace",
    value: unknown,
  ): Promise<void> => {
    if (base === "username") {
      if (opKind === "remove" || typeof value !== "string" || !value.trim()) {
        throw new ScimError(400, "userName is required.", "invalidValue");
      }
      if (await applyUserName(scim.organizationId, current, value)) {
        changed.userName = true;
        await refresh();
      }
      return;
    }

    if (base === "active") {
      if (opKind === "remove") {
        throw new ScimError(400, "active cannot be removed.", "invalidValue");
      }
      const coerced = coerceScimBoolean(value);
      if (coerced === null) {
        throw new ScimError(400, "active must be a boolean.", "invalidValue");
      }
      if (await applyActive(scim.organizationId, current, coerced)) {
        changed.active = true;
        await refresh();
      }
      return;
    }

    if (base === "displayname") {
      const displayName =
        opKind === "remove"
          ? null
          : typeof value === "string" && value.trim()
            ? value.trim()
            : null;
      if (displayName !== current.name) {
        await updateMemberProfile(scim.organizationId, current.userId, {
          displayName,
        });
        changed.name = true;
        await refresh();
      }
      return;
    }

    if (base === "name") {
      // Whole-object replace (or clear) of the stored components.
      const components =
        opKind === "remove"
          ? null
          : typeof value === "object" && value !== null && !Array.isArray(value)
            ? asJsonObject(value as Record<string, unknown>)
            : null;
      await updateMemberProfile(scim.organizationId, current.userId, {
        nameComponents: components,
      });
      changed.name = true;
      await refresh();
      return;
    }

    if (base.startsWith("name.")) {
      // Single sub-attribute (path-parsed keys arrive lowercased).
      const sub = base.slice("name.".length);
      const canonical = CANONICAL_NAME_KEYS[sub];
      if (!canonical) {
        log.info(
          { path: base, op: opKind, organizationId: scim.organizationId },
          "ignoring unsupported scim name sub-attribute",
        );
        return;
      }
      const components = storedComponents(current);
      if (opKind === "remove") {
        delete components[canonical];
      } else {
        components[canonical] = value;
      }
      await updateMemberProfile(scim.organizationId, current.userId, {
        nameComponents:
          Object.keys(components).length > 0 ? asJsonObject(components) : null,
      });
      changed.name = true;
      await refresh();
      return;
    }

    // Unmapped attributes (externalId, emails, title, …) are accepted and
    // ignored — provisioning must not fail over attributes we don't store.
    log.info(
      { path: base, op: opKind, organizationId: scim.organizationId },
      "ignoring unsupported scim user patch path",
    );
  };

  for (const op of operations) {
    if (op.path === undefined) {
      // No-path add/replace with a value object (the Entra shape).
      if (op.op === "remove") {
        // RFC 7644 §3.5.2.2: remove without "path" → 400 noTarget.
        throw new ScimError(400, "remove requires a path.", "noTarget");
      }
      const value = op.value;
      if (typeof value !== "object" || value === null) {
        throw new ScimError(
          400,
          "Operations without a path must carry an object value.",
          "invalidValue",
        );
      }
      for (const [key, keyValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        await applyAttribute(parseScimPath(key).base, op.op, keyValue);
      }
      continue;
    }
    await applyAttribute(op.path.base, op.op, op.value);
  }

  if (changed.name || changed.active || changed.userName) {
    await scimAudit(scim, AUDIT_ACTIONS.UPDATE, AUDIT_SERVICES.MEMBER, {
      userId: member.userId,
      email: member.email,
      nameChanged: changed.name,
      activeChanged: changed.active,
      userNameChanged: changed.userName,
      // The rename target — "renamed to what?" must be answerable from
      // the audit row alone.
      ...(changed.userName ? { newEmail: current.email } : {}),
    });
  }

  return scimResource(
    c,
    toScimUser(
      current,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
  );
});

// Entra sends DELETE for hard deprovisioning; the effect is the same
// reversible suspension as active:false — never a destructive delete.
// A REPEAT delete answers 404 (the Entra validator's expectation for a
// deleted resource): safe because Entra treats 404-on-DELETE as
// already-gone — including its deactivate-then-hard-delete sequence and
// lost-response retries — and Okta never DELETEs users. The member row
// survives either way; only the wire answer for the repeat changes.
usersRouter.delete("/:id", async (c) => {
  const scim = c.get("scim");
  const member = await requireMember(scim.organizationId, c.req.param("id"));

  if (member.status === "suspended") {
    throw new ScimError(404, "User not found.");
  }

  const actor = await resolveScimActor(scim.organizationId);
  await deactivateMember(scim.organizationId, member.userId, actor.userId);
  await scimAudit(scim, AUDIT_ACTIONS.UPDATE, AUDIT_SERVICES.MEMBER, {
    userId: member.userId,
    email: member.email,
    activeChanged: true,
    via: "delete",
  });

  return c.body(null, 204);
});
