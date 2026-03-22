-- Rename tables
ALTER TABLE "User" RENAME TO "user";
ALTER TABLE "Agent" RENAME TO "agent";
ALTER TABLE "Secret" RENAME TO "secret";
ALTER TABLE "PolicyRule" RENAME TO "policy_rule";
ALTER TABLE "AgentSecret" RENAME TO "agent_secret";
ALTER TABLE "ConnectedService" RENAME TO "connected_service";
ALTER TABLE "AuditLog" RENAME TO "audit_log";
ALTER TABLE "VaultConnection" RENAME TO "vault_connection";

-- Rename columns: user
ALTER TABLE "user" RENAME COLUMN "externalAuthId" TO "external_auth_id";
ALTER TABLE "user" RENAME COLUMN "apiKey" TO "api_key";
ALTER TABLE "user" RENAME COLUMN "stripeCustomerId" TO "stripe_customer_id";
ALTER TABLE "user" RENAME COLUMN "subscriptionStatus" TO "subscription_status";
ALTER TABLE "user" RENAME COLUMN "demoSeeded" TO "demo_seeded";
ALTER TABLE "user" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "user" RENAME COLUMN "updatedAt" TO "updated_at";

-- Rename columns: agent
ALTER TABLE "agent" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "agent" RENAME COLUMN "accessToken" TO "access_token";
ALTER TABLE "agent" RENAME COLUMN "isDefault" TO "is_default";
ALTER TABLE "agent" RENAME COLUMN "secretMode" TO "secret_mode";
ALTER TABLE "agent" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "agent" RENAME COLUMN "updatedAt" TO "updated_at";

-- Rename columns: secret
ALTER TABLE "secret" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "secret" RENAME COLUMN "encryptedValue" TO "encrypted_value";
ALTER TABLE "secret" RENAME COLUMN "hostPattern" TO "host_pattern";
ALTER TABLE "secret" RENAME COLUMN "pathPattern" TO "path_pattern";
ALTER TABLE "secret" RENAME COLUMN "injectionConfig" TO "injection_config";
ALTER TABLE "secret" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "secret" RENAME COLUMN "updatedAt" TO "updated_at";

-- Rename columns: policy_rule
ALTER TABLE "policy_rule" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "policy_rule" RENAME COLUMN "hostPattern" TO "host_pattern";
ALTER TABLE "policy_rule" RENAME COLUMN "pathPattern" TO "path_pattern";
ALTER TABLE "policy_rule" RENAME COLUMN "agentId" TO "agent_id";
ALTER TABLE "policy_rule" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "policy_rule" RENAME COLUMN "updatedAt" TO "updated_at";

-- Rename columns: agent_secret
ALTER TABLE "agent_secret" RENAME COLUMN "agentId" TO "agent_id";
ALTER TABLE "agent_secret" RENAME COLUMN "secretId" TO "secret_id";

-- Rename columns: connected_service
ALTER TABLE "connected_service" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "connected_service" RENAME COLUMN "accessToken" TO "access_token";
ALTER TABLE "connected_service" RENAME COLUMN "refreshToken" TO "refresh_token";
ALTER TABLE "connected_service" RENAME COLUMN "tokenExpiry" TO "token_expiry";
ALTER TABLE "connected_service" RENAME COLUMN "connectedAt" TO "connected_at";
ALTER TABLE "connected_service" RENAME COLUMN "updatedAt" TO "updated_at";

-- Rename columns: audit_log
ALTER TABLE "audit_log" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "audit_log" RENAME COLUMN "createdAt" TO "created_at";

-- Rename columns: vault_connection
ALTER TABLE "vault_connection" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "vault_connection" RENAME COLUMN "connectionData" TO "connection_data";
ALTER TABLE "vault_connection" RENAME COLUMN "lastConnectedAt" TO "last_connected_at";
ALTER TABLE "vault_connection" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "vault_connection" RENAME COLUMN "updatedAt" TO "updated_at";
