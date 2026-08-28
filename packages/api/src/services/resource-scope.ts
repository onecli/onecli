export interface ResourceScope {
  workspaceId?: string;
  organizationId?: string;
}

export const scopeWhere = (scope: ResourceScope) => {
  if (scope.workspaceId && scope.organizationId) {
    return {
      OR: [
        { workspaceId: scope.workspaceId },
        {
          organizationId: scope.organizationId,
          scope: "organization" as const,
        },
      ],
    };
  }
  if (scope.organizationId) {
    return {
      organizationId: scope.organizationId,
      scope: "organization" as const,
    };
  }
  if (scope.workspaceId) {
    return { workspaceId: scope.workspaceId };
  }
  throw new Error("ResourceScope must have workspaceId or organizationId");
};

export const scopeCreate = (scope: ResourceScope) => {
  if (scope.workspaceId && scope.organizationId) {
    throw new Error(
      "Cannot create a resource with both workspaceId and organizationId",
    );
  }
  if (scope.organizationId) {
    return {
      organizationId: scope.organizationId,
      scope: "organization" as const,
    };
  }
  if (scope.workspaceId) {
    return { workspaceId: scope.workspaceId, scope: "workspace" as const };
  }
  throw new Error("ResourceScope must have workspaceId or organizationId");
};

export const scopeOwnership = (scope: ResourceScope, id: string) => {
  if (scope.organizationId) {
    return {
      id,
      organizationId: scope.organizationId,
      scope: "organization" as const,
    };
  }
  if (scope.workspaceId) {
    return { id, workspaceId: scope.workspaceId };
  }
  throw new Error("ResourceScope must have workspaceId or organizationId");
};

export const appConfigKey = (scope: ResourceScope, provider: string) => {
  if (scope.organizationId) {
    return {
      organizationId_provider: {
        organizationId: scope.organizationId,
        provider,
      },
    };
  }
  if (scope.workspaceId) {
    return {
      workspaceId_provider: { workspaceId: scope.workspaceId, provider },
    };
  }
  throw new Error("ResourceScope must have workspaceId or organizationId");
};

export const isOrgScope = (scope: ResourceScope): boolean =>
  !!scope.organizationId && !scope.workspaceId;
