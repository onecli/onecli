export interface OAuthBuildAuthUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}

export interface OAuthExchangeCodeParams {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OAuthExchangeResult {
  credentials: Record<string, unknown>;
  scopes: string[];
  metadata?: Record<string, unknown>;
}

/** Human-friendly description of an OAuth permission/scope. */
export interface OAuthPermission {
  /** The OAuth scope string (e.g., "repo", "user"). */
  scope: string;
  /** User-facing name (e.g., "Repositories"). */
  name: string;
  /** Short description (e.g., "Public and private repos, issues, PRs"). */
  description: string;
  /** Access level indicator. */
  access: "read" | "write";
}

export type ConnectionMethod =
  | {
      type: "oauth";
      defaultScopes?: string[];
      /** Human-friendly permission descriptions. Drives the permissions UI. */
      permissions?: OAuthPermission[];
      buildAuthUrl: (params: OAuthBuildAuthUrlParams) => string;
      exchangeCode: (
        params: OAuthExchangeCodeParams,
      ) => Promise<OAuthExchangeResult>;
    }
  | {
      type: "api_key";
      fields: {
        name: string;
        label: string;
        description?: string;
        placeholder: string;
      }[];
    }
  | {
      type: "credentials_import";
      fields: {
        name: string;
        label: string;
        description?: string;
        placeholder: string;
        secret?: boolean;
        /** When set, field is only shown when this group is active (e.g., "service_account"). */
        group?: string;
      }[];
      exchangeCredentials: (
        fields: Record<string, string>,
      ) => Promise<OAuthExchangeResult>;
      /** Optional file import to auto-fill fields from a JSON file. */
      fileImport?: {
        /** Button label (e.g., "Import from credentials file"). */
        label: string;
        /** File input accept filter (e.g., ".json,application/json"). */
        accept: string;
        /** Maps JSON keys in the file to field names in the form. */
        keyMap: Record<string, string>;
      };
    };

export interface OAuthConfigField {
  name: string;
  label: string;
  description?: string;
  placeholder: string;
  /** If true, stored encrypted in AppConfig.credentials. Otherwise in AppConfig.settings. */
  secret?: boolean;
}

export interface AppDefinition {
  id: string;
  name: string;
  icon: string;
  /** Icon variant for dark mode. Falls back to `icon` if not set. */
  darkIcon?: string;
  description: string;
  connectionMethod: ConnectionMethod;
  available: boolean;
  /** Credential stubs for provisioners to write so MCP servers can boot. */
  credentialStubs?: {
    /** Full destination path (e.g., "~/.config/gcloud/application_default_credentials.json"). */
    path: string;
    /** Stub content with "onecli-managed" sentinel values. */
    content: Record<string, unknown>;
  }[];
  /** OAuth apps can be configured with custom credentials (BYOC). */
  configurable?: {
    fields: OAuthConfigField[];
    /** Maps field names to env var names for platform defaults. Omit if no defaults exist. */
    envDefaults?: Record<string, string>;
    /** Short hint shown above the credential fields (e.g., "Use credentials from a GitHub OAuth App"). */
    hint?: string;
  };
}
