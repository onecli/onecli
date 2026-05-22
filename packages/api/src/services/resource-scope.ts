export interface ResourceScope {
  projectId?: string;
  organizationId?: string;
}

export const scopeWhere = (scope: ResourceScope) => {
  if (scope.projectId && scope.organizationId) {
    return {
      OR: [
        { projectId: scope.projectId },
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
  if (scope.projectId) {
    return { projectId: scope.projectId };
  }
  throw new Error("ResourceScope must have projectId or organizationId");
};

export const scopeCreate = (scope: ResourceScope) => {
  if (scope.projectId && scope.organizationId) {
    throw new Error(
      "Cannot create a resource with both projectId and organizationId",
    );
  }
  if (scope.organizationId) {
    return {
      organizationId: scope.organizationId,
      scope: "organization" as const,
    };
  }
  if (scope.projectId) {
    return { projectId: scope.projectId, scope: "project" as const };
  }
  throw new Error("ResourceScope must have projectId or organizationId");
};

export const scopeOwnership = (scope: ResourceScope, id: string) => {
  if (scope.organizationId) {
    return {
      id,
      organizationId: scope.organizationId,
      scope: "organization" as const,
    };
  }
  if (scope.projectId) {
    return { id, projectId: scope.projectId };
  }
  throw new Error("ResourceScope must have projectId or organizationId");
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
  if (scope.projectId) {
    return {
      projectId_provider: { projectId: scope.projectId, provider },
    };
  }
  throw new Error("ResourceScope must have projectId or organizationId");
};

export const isOrgScope = (scope: ResourceScope): boolean =>
  !!scope.organizationId && !scope.projectId;
