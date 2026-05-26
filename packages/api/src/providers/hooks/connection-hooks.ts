export interface ConnectionHooks {
  beforeConnect(
    organizationId: string,
    appDef: { teamOnly?: boolean },
  ): Promise<void>;
  beforeCreate(organizationId: string): Promise<void>;
}

const defaultConnectionHooks: ConnectionHooks = {
  beforeConnect: async () => {},
  beforeCreate: async () => {},
};

let _connectionHooks: ConnectionHooks = defaultConnectionHooks;

export const initConnectionHooks = (h: ConnectionHooks) => {
  _connectionHooks = h;
};

export const getConnectionHooks = (): ConnectionHooks => _connectionHooks;
