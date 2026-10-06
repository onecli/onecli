export interface OAuthBuildAuthUrlParams {
  appCredentials: Record<string, string>;
  redirectUri: string;
  scopes: string[];
  state: string;
}

export interface OAuthExchangeCodeParams {
  appCredentials: Record<string, string>;
  callbackParams: Record<string, string>;
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

/**
 * Where a server-owned connect field's value comes from. Each source is
 * resolved from the CALLER'S AUTHENTICATED SCOPE by the connect routes — never
 * from request input — so a field declared here cannot be forged by a client.
 */
export type ServerFieldSource = "orgAwsExternalId";

/**
 * A connect field the server fills in, not the user. It is handed to
 * `exchangeCredentials` under `name` exactly like a form field, but any
 * client-submitted value for that name is DISCARDED first.
 *
 * This exists for values that are a fact about the tenant rather than an input
 * — AWS's `sts:ExternalId` being the motivating case: its whole purpose (the
 * confused-deputy defense) collapses if the caller can choose it.
 */
export interface ServerField {
  /** The field name `exchangeCredentials` reads. */
  name: string;
  source: ServerFieldSource;
}

export type ConnectionMethod =
  | {
      type: "oauth";
      defaultScopes?: string[];
      /** Human-friendly permission descriptions. No runtime reader since the
       *  app-page permissions panel was removed — kept as source data for the
       *  docs permission tables (the sync-app-docs skill reads it). */
      permissions?: OAuthPermission[];
      /** Providers that return the token in a URL fragment (#token=...) instead
       *  of a query parameter. The bridge page extracts the named param from the
       *  fragment and resubmits it as a query parameter for the server. */
      fragmentCallback?: { paramName: string };
      /** May be async: the registry graph is client-reachable, so a definition
       *  needing node builtins (PKCE/JWT crypto) must load them via a lazy
       *  `await import("node:crypto")` instead of a top-level import. */
      buildAuthUrl: (
        params: OAuthBuildAuthUrlParams,
      ) => string | Promise<string>;
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
        /** When true, the field is not required. */
        optional?: boolean;
        /** When false, the field is shown as plain text instead of masked. */
        secret?: boolean;
        /** Optional clickable link shown under the field (e.g. where to create the key). */
        helpUrl?: string;
        /** Label for the help link; defaults to "Learn more". */
        helpLabel?: string;
      }[];
      /** Resolve metadata for the connection (e.g., org name, dashboard URL). */
      resolveMetadata?: (
        fields: Record<string, string>,
      ) => Promise<Record<string, unknown> | null>;
    }
  | {
      type: "credentials_import";
      fields: {
        name: string;
        label: string;
        description?: string;
        placeholder: string;
        secret?: boolean;
        /** When true, the field is not required. */
        optional?: boolean;
        /** When set, field is only shown when this group is active (e.g., "service_account"). */
        group?: string;
      }[];
      exchangeCredentials: (
        fields: Record<string, string>,
      ) => Promise<OAuthExchangeResult>;
      /** Fields the SERVER supplies from the caller's scope (see
       *  `ServerField`). Merged over the submitted fields — and stripped from
       *  them first — before `exchangeCredentials` runs. */
      serverFields?: ServerField[];
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

export interface OAuthConfigFieldOption {
  /** The stored value, which is what the server-side code switches on. */
  value: string;
  /** What the user sees on the toggle. */
  label: string;
}

export interface OAuthConfigField {
  name: string;
  label: string;
  description?: string;
  /** Text fields only; ignored when `options` is set. */
  placeholder?: string;
  /** If true, stored encrypted in AppConfig.credentials. Otherwise in AppConfig.settings. */
  secret?: boolean;
  /** Fixed choices rendered as a segmented control instead of a text input.
   *  The stored value is always one of these `value`s, so whatever consumes
   *  the setting can switch on them without a free-text fallback. */
  options?: OAuthConfigFieldOption[];
  /** Pre-selected choice for an `options` field; must be one of its values.
   *  Submitted with the config even if the user never touches the control. */
  defaultValue?: string;
}

/**
 * A short note shown in the connect window above the Connect button, for a
 * provider-side prerequisite the user should know before they're sent off
 * (e.g. "an admin must install the app first"). Each part renders on its own
 * line: `text` is the prerequisite, `fallback` is what someone who can't meet
 * it should do instead, and `link` opens our docs in a new tab.
 */
export interface ConnectNote {
  text: string;
  fallback?: string;
  link?: {
    url: string;
    label: string;
  };
}

export interface AppDefinition {
  id: string;
  name: string;
  icon: string;
  /** Icon variant for dark mode. Falls back to `icon` if not set. */
  darkIcon?: string;
  description: string;
  connectionMethod: ConnectionMethod;
  /** Optional alternate connection methods offered alongside the primary
   *  `connectionMethod` (e.g. an API-key option in addition to OAuth). The
   *  connect UI lets the user pick; the connect route resolves the chosen one
   *  via the request's `method` field. */
  additionalMethods?: ConnectionMethod[];
  /** Custom hint for the connection label field (e.g. 'e.g. "staging", "my-org"'). */
  labelHint?: string;
  /**
   * The provider's public API reference (https only). Rendered into a hosted
   * agent's connected-apps section so its first call lands on the real,
   * documented API rather than a guessed one. Curate only a link verified to
   * resolve: an agent follows it.
   */
  apiDocsUrl?: string;
  connectNote?: ConnectNote;
  /** Credential stubs for provisioners to write so MCP servers can boot. */
  credentialStubs?: {
    /** Full destination path (e.g., "~/.config/gcloud/application_default_credentials.json"). */
    path: string;
    /** Stub content with "onecli-managed" sentinel values. */
    content: Record<string, unknown>;
  }[];
  /** Hosts to block by default when this app is connected (e.g., public registries). */
  blocklist?: {
    id: string;
    name: string;
    hostPattern: string;
  }[];
  /** OAuth apps can be configured with custom credentials (BYOC). */
  configurable?: {
    fields: OAuthConfigField[];
    /** Maps field names to env var names for platform defaults. Omit if no defaults exist. */
    envDefaults?: Record<string, string>;
    /** Short hint shown above the credential fields (e.g., "Use credentials from a GitHub OAuth App"). */
    hint?: string;
    /** A docs page that walks through creating the provider's OAuth app and
     *  finding these credentials. Linked from the setup dialog as "Follow the
     *  {app} setup guide". Only point at pages that actually cover that; a
     *  usage page would send a stuck user somewhere that can't help. */
    setupGuideUrl?: string;
  };
}
