import { Hono } from "hono";
import { logger } from "../../lib/logger";
import { AUDIT_ACTIONS, AUDIT_SERVICES } from "../../services/audit-service";
import {
  findScimGroupById,
  listGroupsOffset,
  scimAddGroupMember,
  scimCreateGroup,
  scimDeleteGroup,
  scimRemoveGroupMember,
  scimRenameGroup,
  scimSetGroupExternalId,
  scimSetGroupMembers,
  type ScimGroupFilter,
  type ScimGroupRecord,
} from "../services/org-directory-service";
import { type ScimEnv } from "./auth";
import { scimAudit } from "./audit";
import { ScimError } from "./errors";
import { parseSupportedEqFilter } from "./filter";
import { parsePatchBody, scimAttr, type ScimPatchOp } from "./patch";
import { readScimBody, scimJson, scimResource } from "./respond";
import {
  parsePagination,
  scimBaseUrl,
  toListResponse,
  toScimGroup,
} from "./serialization";

const log = logger.child({ component: "scim-groups" });

/**
 * /scim/v2/Groups — 12b, source:"scim" rows only. SCIM owns displayName +
 * members + externalId — never the group's role mapping. Nested groups are not
 * expanded: a member entry that isn't a user id is rejected.
 * Writes go through the guard-free directory cores; the manual /v1 surface
 * keeps its managed-by-IdP 409 lock, so the two writers never fight.
 */

const GROUP_FILTER_HINT = "Match groups by displayName or externalId.";

const requireScimGroup = async (
  organizationId: string,
  groupId: string,
  includeMembers = true,
): Promise<ScimGroupRecord> => {
  const group = await findScimGroupById(
    organizationId,
    groupId,
    includeMembers,
  );
  if (!group) throw new ScimError(404, "Group not found.");
  return group;
};

const requireDisplayName = (body: Record<string, unknown>): string => {
  const displayName = scimAttr(body, "displayName");
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    throw new ScimError(400, "displayName is required.", "invalidValue");
  }
  return displayName.trim();
};

const externalIdFrom = (body: Record<string, unknown>): string | null => {
  const externalId = scimAttr(body, "externalId");
  return typeof externalId === "string" && externalId.trim()
    ? externalId.trim()
    : null;
};

/** members arrays arrive as [{ value: "<user id>", display?, $ref? }, …]. */
const memberIdsFrom = (value: unknown): string[] => {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => {
    if (typeof entry === "object" && entry !== null) {
      const id = scimAttr(entry as Record<string, unknown>, "value");
      if (typeof id === "string" && id.trim()) return id.trim();
    }
    throw new ScimError(
      400,
      'members entries must be objects with a "value" user id.',
      "invalidValue",
    );
  });
};

const excludesMembers = (c: {
  req: { query: (k: string) => string | undefined };
}) =>
  (c.req.query("excludedAttributes") ?? "")
    .split(",")
    .some((attr) => attr.trim().toLowerCase() === "members");

export const groupsRouter = new Hono<ScimEnv>();

groupsRouter.get("/", async (c) => {
  const { organizationId } = c.get("scim");
  const baseUrl = scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
  const includeMembers = !excludesMembers(c);
  const { startIndex, count } = parsePagination(c.req.query());

  const rawFilter = c.req.query("filter");
  let filter: ScimGroupFilter | undefined;
  if (rawFilter !== undefined) {
    // Okta's Push Groups flow looks groups up by displayName before linking.
    const parsed = parseSupportedEqFilter(
      rawFilter,
      ["displayname", "externalid"],
      GROUP_FILTER_HINT,
    );
    filter =
      parsed.attribute === "displayname"
        ? { attribute: "displayname", value: parsed.value }
        : { attribute: "externalid", value: parsed.value };
  }

  const page = await listGroupsOffset(organizationId, startIndex, count, {
    filter,
    includeMembers,
  });
  return scimJson(
    c,
    toListResponse(
      page.groups.map((g) => toScimGroup(g, baseUrl)),
      page.totalResults,
      startIndex,
    ),
    200,
  );
});

groupsRouter.get("/:id", async (c) => {
  const { organizationId } = c.get("scim");
  const group = await requireScimGroup(
    organizationId,
    c.req.param("id"),
    !excludesMembers(c),
  );
  return scimResource(
    c,
    toScimGroup(
      group,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
  );
});

groupsRouter.post("/", async (c) => {
  const scim = c.get("scim");
  const body = await readScimBody(c);
  const displayName = requireDisplayName(body);
  const externalId = externalIdFrom(body);

  // Okta creates groups with empty members and PATCHes them in after;
  // a members list on create is honored when present.
  const created = await scimCreateGroup(
    scim.organizationId,
    displayName,
    externalId,
  );
  const membersRaw = scimAttr(body, "members");
  if (Array.isArray(membersRaw) && membersRaw.length > 0) {
    await scimSetGroupMembers(
      scim.organizationId,
      created.id,
      memberIdsFrom(membersRaw),
    );
  }

  await scimAudit(scim, AUDIT_ACTIONS.CREATE, AUDIT_SERVICES.GROUP, {
    groupId: created.id,
    name: displayName,
    externalId,
  });

  const group = await requireScimGroup(scim.organizationId, created.id);
  return scimResource(
    c,
    toScimGroup(
      group,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
    201,
  );
});

// Full replace — the wizard-app flow: displayName + the complete members set.
groupsRouter.put("/:id", async (c) => {
  const scim = c.get("scim");
  const group = await requireScimGroup(scim.organizationId, c.req.param("id"));
  const body = await readScimBody(c);
  const displayName = requireDisplayName(body);

  if (displayName !== group.name) {
    await scimRenameGroup(scim.organizationId, group.id, displayName);
  }
  const externalId = externalIdFrom(body);
  const externalIdChanged =
    scimAttr(body, "externalId") !== undefined &&
    externalId !== group.externalId;
  if (externalIdChanged) {
    await scimSetGroupExternalId(scim.organizationId, group.id, externalId);
  }
  const membersRaw = scimAttr(body, "members");
  let membersReplaced = false;
  if (membersRaw !== undefined) {
    const ids = Array.isArray(membersRaw) ? memberIdsFrom(membersRaw) : [];
    await scimSetGroupMembers(scim.organizationId, group.id, ids);
    membersReplaced = true;
  }

  await scimAudit(scim, AUDIT_ACTIONS.UPDATE, AUDIT_SERVICES.GROUP, {
    groupId: group.id,
    name: displayName,
    renamed: displayName !== group.name,
    membersReplaced,
    externalIdChanged,
  });

  const updated = await requireScimGroup(scim.organizationId, group.id);
  return scimResource(
    c,
    toScimGroup(
      updated,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
  );
});

const applyGroupPatchOp = async (
  organizationId: string,
  groupId: string,
  op: ScimPatchOp,
): Promise<void> => {
  // No-path replace with an object value — Okta renames groups this way.
  if (op.path === undefined) {
    if (op.op === "remove") {
      // RFC 7644 §3.5.2.2: remove without "path" → 400 noTarget.
      throw new ScimError(400, "remove requires a path.", "noTarget");
    }
    if (typeof op.value !== "object" || op.value === null) {
      throw new ScimError(
        400,
        "Operations without a path must carry an object value.",
        "invalidValue",
      );
    }
    const record = op.value as Record<string, unknown>;
    const displayName = scimAttr(record, "displayName");
    if (typeof displayName === "string" && displayName.trim()) {
      await scimRenameGroup(organizationId, groupId, displayName.trim());
    }
    const externalId = scimAttr(record, "externalId");
    if (externalId !== undefined) {
      await scimSetGroupExternalId(
        organizationId,
        groupId,
        typeof externalId === "string" && externalId.trim()
          ? externalId.trim()
          : null,
      );
    }
    const members = scimAttr(record, "members");
    if (members !== undefined) {
      await scimSetGroupMembers(
        organizationId,
        groupId,
        Array.isArray(members) ? memberIdsFrom(members) : [],
      );
    }
    return;
  }

  const base = op.path.base;
  if (base === "displayname") {
    if (
      op.op === "remove" ||
      typeof op.value !== "string" ||
      !op.value.trim()
    ) {
      throw new ScimError(
        400,
        "displayName must be replaced with a non-empty string.",
        "invalidValue",
      );
    }
    await scimRenameGroup(organizationId, groupId, op.value.trim());
    return;
  }

  if (base === "externalid") {
    const externalId =
      op.op === "remove"
        ? null
        : typeof op.value === "string" && op.value.trim()
          ? op.value.trim()
          : null;
    await scimSetGroupExternalId(organizationId, groupId, externalId);
    return;
  }

  if (base === "members") {
    // Okta remove syntax 1: members[value eq "<user id>"]
    if (op.path.filter) {
      if (op.path.filter.attribute !== "value" || op.op !== "remove") {
        throw new ScimError(
          400,
          'members filters support remove by [value eq "<user id>"] only.',
          "invalidPath",
        );
      }
      await scimRemoveGroupMember(
        organizationId,
        groupId,
        op.path.filter.value,
      );
      return;
    }
    if (op.op === "add") {
      for (const userId of memberIdsFrom(op.value)) {
        await scimAddGroupMember(organizationId, groupId, userId);
      }
      return;
    }
    if (op.op === "replace") {
      await scimSetGroupMembers(
        organizationId,
        groupId,
        op.value === undefined ? [] : memberIdsFrom(op.value),
      );
      return;
    }
    // Okta remove syntax 2: op-level value array; no value at all = clear.
    if (op.value === undefined) {
      await scimSetGroupMembers(organizationId, groupId, []);
      return;
    }
    for (const userId of memberIdsFrom(op.value)) {
      await scimRemoveGroupMember(organizationId, groupId, userId);
    }
    return;
  }

  // Anything else we don't map: accepted, ignored, logged — provisioning
  // must not fail over unmapped attributes.
  log.info(
    { path: base, op: op.op, organizationId },
    "ignoring unsupported scim group patch path",
  );
};

groupsRouter.patch("/:id", async (c) => {
  const scim = c.get("scim");
  const group = await requireScimGroup(
    scim.organizationId,
    c.req.param("id"),
    false,
  );
  const operations = parsePatchBody(await readScimBody(c));

  for (const op of operations) {
    await applyGroupPatchOp(scim.organizationId, group.id, op);
  }

  await scimAudit(scim, AUDIT_ACTIONS.UPDATE, AUDIT_SERVICES.GROUP, {
    groupId: group.id,
    name: group.name,
    operations: operations.map((op) => ({
      op: op.op,
      path: op.path?.base ?? null,
    })),
  });

  const updated = await requireScimGroup(scim.organizationId, group.id);
  return scimResource(
    c,
    toScimGroup(
      updated,
      scimBaseUrl(c.req.url, c.req.header("x-forwarded-proto")),
    ),
  );
});

groupsRouter.delete("/:id", async (c) => {
  const scim = c.get("scim");
  const group = await requireScimGroup(
    scim.organizationId,
    c.req.param("id"),
    false,
  );
  await scimDeleteGroup(scim.organizationId, group.id);
  await scimAudit(scim, AUDIT_ACTIONS.DELETE, AUDIT_SERVICES.GROUP, {
    groupId: group.id,
    name: group.name,
  });
  return c.body(null, 204);
});
