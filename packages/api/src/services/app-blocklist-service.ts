import { db } from "@onecli/db";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, isOrgScope } from "./resource-scope";
import { ServiceError } from "./errors";

export interface BlocklistHostState {
  hostId: string;
  ruleId: string | null;
  enabled: boolean;
  custom: boolean;
  name: string;
  hostPattern: string;
  scope: "organization" | "project" | null;
}

interface BlocklistRuleMetadata {
  source: string;
  type: string;
  provider: string;
  hostId: string;
  custom?: boolean;
  customName?: string;
}

type BlocklistHost = { id: string; name: string; hostPattern: string };

const BLOCKLIST_WHERE = [
  { metadata: { path: ["source"], equals: "app_permission" } },
  { metadata: { path: ["type"], equals: "blocklist" } },
] as const;

const listRules = async (scope: ResourceScope, provider: string) =>
  db.policyRule.findMany({
    where: {
      ...scopeWhere(scope),
      AND: [
        ...BLOCKLIST_WHERE,
        { metadata: { path: ["provider"], equals: provider } },
      ],
    },
    select: {
      id: true,
      name: true,
      hostPattern: true,
      enabled: true,
      metadata: true,
      scope: true,
    },
  });

export const initBlocklistDefaults = async (
  scope: ResourceScope,
  provider: string,
  hosts: BlocklistHost[],
): Promise<void> => {
  const existing = await listRules(scope, provider);
  const existingHostIds = new Set(
    existing
      .map((r) => (r.metadata as BlocklistRuleMetadata | null)?.hostId)
      .filter(Boolean),
  );

  const toCreate = hosts.filter((h) => !existingHostIds.has(h.id));
  if (toCreate.length === 0) return;

  await db.$transaction(async (tx) => {
    for (const host of toCreate) {
      await tx.policyRule.create({
        data: {
          ...scopeCreate(scope),
          agentId: isOrgScope(scope) ? null : undefined,
          name: `Block ${host.name}`,
          hostPattern: host.hostPattern,
          pathPattern: null,
          method: null,
          action: "block",
          enabled: true,
          metadata: {
            source: "app_permission",
            type: "blocklist",
            provider,
            hostId: host.id,
          },
        },
      });
    }
  });
};

export const getBlocklistState = async (
  scope: ResourceScope,
  provider: string,
  hosts: BlocklistHost[],
): Promise<BlocklistHostState[]> => {
  const existing = await listRules(scope, provider);

  const rulesByHostId = new Map<string, (typeof existing)[number]>();
  const customRules: (typeof existing)[number][] = [];
  for (const rule of existing) {
    const meta = rule.metadata as BlocklistRuleMetadata | null;
    if (!meta?.hostId) continue;
    if (meta.custom) {
      customRules.push(rule);
    } else {
      const prev = rulesByHostId.get(meta.hostId);
      if (!prev || rule.scope === "organization") {
        rulesByHostId.set(meta.hostId, rule);
      }
    }
  }

  const ruleScope = (rule: { scope: string }) =>
    rule.scope as "organization" | "project";

  const predefined: BlocklistHostState[] = hosts.map((host) => {
    const rule = rulesByHostId.get(host.id);
    return {
      hostId: host.id,
      ruleId: rule?.id ?? null,
      enabled: rule?.enabled ?? false,
      custom: false,
      name: host.name,
      hostPattern: host.hostPattern,
      scope: rule ? ruleScope(rule) : null,
    };
  });

  const custom: BlocklistHostState[] = customRules.map((rule) => {
    const meta = rule.metadata as unknown as BlocklistRuleMetadata;
    return {
      hostId: meta.hostId,
      ruleId: rule.id,
      enabled: rule.enabled,
      custom: true,
      name: meta.customName ?? rule.name,
      hostPattern: rule.hostPattern,
      scope: ruleScope(rule),
    };
  });

  return [...predefined, ...custom];
};

export const toggleBlocklistRule = async (
  scope: ResourceScope,
  ruleId: string,
  enabled: boolean,
): Promise<void> => {
  const rule = await db.policyRule.findFirst({
    where: { id: ruleId, ...scopeWhere(scope) },
    select: { id: true },
  });
  if (!rule) throw new ServiceError("NOT_FOUND", "Blocklist rule not found");

  await db.policyRule.update({
    where: { id: ruleId },
    data: { enabled },
  });
};

export const activateBlocklistHost = async (
  scope: ResourceScope,
  provider: string,
  hostId: string,
  hosts: BlocklistHost[],
): Promise<BlocklistHostState> => {
  const host = hosts.find((h) => h.id === hostId);
  if (!host) throw new ServiceError("BAD_REQUEST", "Unknown blocklist host ID");

  const duplicate = await db.policyRule.findFirst({
    where: {
      ...scopeWhere(scope),
      AND: [
        ...BLOCKLIST_WHERE,
        { metadata: { path: ["provider"], equals: provider } },
        { metadata: { path: ["hostId"], equals: hostId } },
      ],
    },
    select: { id: true, enabled: true },
  });
  if (duplicate) {
    if (!duplicate.enabled) {
      await db.policyRule.update({
        where: { id: duplicate.id },
        data: { enabled: true },
      });
    }
    return {
      hostId,
      ruleId: duplicate.id,
      enabled: true,
      custom: false,
      name: host.name,
      hostPattern: host.hostPattern,
      scope: isOrgScope(scope)
        ? ("organization" as const)
        : ("project" as const),
    };
  }

  const rule = await db.policyRule.create({
    data: {
      ...scopeCreate(scope),
      agentId: isOrgScope(scope) ? null : undefined,
      name: `Block ${host.name}`,
      hostPattern: host.hostPattern,
      pathPattern: null,
      method: null,
      action: "block",
      enabled: true,
      metadata: {
        source: "app_permission",
        type: "blocklist",
        provider,
        hostId,
      },
    },
    select: { id: true },
  });

  return {
    hostId,
    ruleId: rule.id,
    enabled: true,
    custom: false,
    name: host.name,
    hostPattern: host.hostPattern,
    scope: isOrgScope(scope) ? ("organization" as const) : ("project" as const),
  };
};

export const addCustomBlocklistRule = async (
  scope: ResourceScope,
  provider: string,
  name: string,
  hostPattern: string,
): Promise<BlocklistHostState> => {
  const trimmedHost = hostPattern.trim();
  const trimmedName = name.trim();
  if (!trimmedHost || !trimmedName)
    throw new ServiceError("BAD_REQUEST", "Name and host are required");

  const hostId = `custom:${trimmedHost}`;

  const duplicate = await db.policyRule.findFirst({
    where: {
      ...scopeWhere(scope),
      AND: [
        ...BLOCKLIST_WHERE,
        { metadata: { path: ["provider"], equals: provider } },
        { metadata: { path: ["hostId"], equals: hostId } },
      ],
    },
    select: { id: true },
  });
  if (duplicate)
    throw new ServiceError("CONFLICT", "This host is already blocked");

  const rule = await db.policyRule.create({
    data: {
      ...scopeCreate(scope),
      agentId: isOrgScope(scope) ? null : undefined,
      name: `Block ${trimmedName}`,
      hostPattern: trimmedHost,
      pathPattern: null,
      method: null,
      action: "block",
      enabled: true,
      metadata: {
        source: "app_permission",
        type: "blocklist",
        provider,
        hostId,
        custom: true,
        customName: trimmedName,
      },
    },
    select: { id: true, enabled: true },
  });

  return {
    hostId,
    ruleId: rule.id,
    enabled: rule.enabled,
    custom: true,
    name: trimmedName,
    hostPattern: trimmedHost,
    scope: isOrgScope(scope) ? ("organization" as const) : ("project" as const),
  };
};

export const removeBlocklistRule = async (
  scope: ResourceScope,
  ruleId: string,
): Promise<void> => {
  const rule = await db.policyRule.findFirst({
    where: {
      id: ruleId,
      ...scopeWhere(scope),
      AND: [...BLOCKLIST_WHERE],
    },
    select: { id: true },
  });
  if (!rule) throw new ServiceError("NOT_FOUND", "Blocklist rule not found");

  await db.policyRule.delete({ where: { id: ruleId } });
};

export const removeAllBlocklistRules = async (
  scope: ResourceScope,
  provider: string,
): Promise<void> => {
  await db.policyRule.deleteMany({
    where: {
      ...scopeWhere(scope),
      AND: [
        ...BLOCKLIST_WHERE,
        { metadata: { path: ["provider"], equals: provider } },
      ],
    },
  });
};
