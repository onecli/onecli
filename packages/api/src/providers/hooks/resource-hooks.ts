export interface ResourceHooks {
  beforeCreateAgent(organizationId: string, projectId: string): Promise<void>;
  beforeCreateSecret(organizationId: string): Promise<void>;
}

const defaultResourceHooks: ResourceHooks = {
  beforeCreateAgent: async () => {},
  beforeCreateSecret: async () => {},
};

let _resourceHooks: ResourceHooks = defaultResourceHooks;

export const initResourceHooks = (h: ResourceHooks) => {
  _resourceHooks = h;
};

export const getResourceHooks = (): ResourceHooks => _resourceHooks;
